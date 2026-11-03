// The seller side, end to end, against a stub facilitator.
//
// What matters here is the sequence a buyer actually experiences: an unpaid
// call gets a 402 with a ticket, a paid call gets the content, and a
// payment cannot be spent twice. The chain and the contract are the
// facilitator's job, so they are stubbed.

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const crypto = require("crypto");

const { requirePayment, issueTicket, verifyTicket } = require("..");

const SELLER = "QPAYNOWSWZMGHFEAEVJXGZAVSHABAZDDBDIHTEBOPCOGHRGBCYCUZOHCVLXG";
const CONTRACT_29 = "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH";
const KEY = crypto.randomBytes(32).toString("hex");

/** A facilitator that settles each reference exactly once. */
function stubFacilitator({ settlement = { name: "contract", contractIndex: 29, contractAddress: CONTRACT_29 } } = {}) {
  const claimed = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/supported") return res.end(JSON.stringify({ settlement }));
      const { paymentPayload } = JSON.parse(body || "{}");
      const ref = paymentPayload && paymentPayload.payload && paymentPayload.payload.reference;
      if (req.url === "/settle") {
        if (claimed.has(ref)) {
          return res.end(JSON.stringify({ success: false, errorReason: "payment_already_used" }));
        }
        claimed.add(ref);
        return res.end(JSON.stringify({ success: true, payer: "PAYER", transaction: ref }));
      }
      res.end(JSON.stringify({ isValid: true, payer: "PAYER" }));
    });
  });
  return server;
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A paywalled app pointed at a given facilitator. */
async function appWith(facilitatorUrl, opts = {}) {
  const express = require("express");
  const app = express();
  app.get(
    "/feed",
    requirePayment({
      sellerId: SELLER,
      ticketKey: KEY,
      amount: 20000,
      resourceId: "/feed",
      facilitator: { url: facilitatorUrl },
      ...opts,
    }),
    (req, res) => res.json({ secret: "the goods", payer: req.payment.payer })
  );
  const server = http.createServer(app);
  return { server, base: await listen(server) };
}

const payHeader = (reference, ticket) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "exact", network: "qubic:mainnet" },
      payload: { reference, ticket },
    })
  ).toString("base64");

test("an unpaid call gets a 402 carrying a ticket, priced, addressed to the contract", async (t) => {
  const fac = stubFacilitator();
  const facBase = await listen(fac);
  const { server, base } = await appWith(facBase);
  t.after(() => { server.close(); fac.close(); });

  const res = await fetch(`${base}/feed`);
  assert.strictEqual(res.status, 402);
  const body = await res.json();

  assert.strictEqual(body.x402Version, 2);
  assert.ok(body.paymentTicket, "a 402 without a ticket cannot be paid safely");
  assert.strictEqual(body.paymentTicketField, "paymentPayload.payload.ticket");

  const req = body.accepts[0];
  assert.strictEqual(req.amount, "20000");
  assert.strictEqual(req.extra.sellerId, SELLER);
  // payTo is the CONTRACT while sellerId stays the seller - the money goes
  // through QPAY, the attribution stays with the merchant.
  assert.strictEqual(req.payTo, CONTRACT_29);

  // And the ticket is genuinely ours, scoped to this exact purchase.
  assert.strictEqual(verifyTicket(KEY, body.paymentTicket, {
    sellerId: SELLER, resourceId: "/feed", amount: "20000",
  }).valid, true);
});

test("direct settlement addresses the 402 to the seller instead", async (t) => {
  const fac = stubFacilitator({ settlement: { name: "direct" } });
  const facBase = await listen(fac);
  const { server, base } = await appWith(facBase);
  t.after(() => { server.close(); fac.close(); });

  const body = await (await fetch(`${base}/feed`)).json();
  assert.strictEqual(body.accepts[0].payTo, SELLER);
});

test("a paid call gets the content", async (t) => {
  const fac = stubFacilitator();
  const facBase = await listen(fac);
  const { server, base } = await appWith(facBase);
  t.after(() => { server.close(); fac.close(); });

  const { paymentTicket } = await (await fetch(`${base}/feed`)).json();
  const res = await fetch(`${base}/feed`, {
    headers: { "X-PAYMENT": payHeader("a".repeat(64), paymentTicket) },
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { secret: "the goods", payer: "PAYER" });
});

test("the same payment cannot buy twice", async (t) => {
  // The paywall SETTLES rather than merely verifying, which is what makes a
  // payment single-use. Verify alone would let both of these through.
  const fac = stubFacilitator();
  const facBase = await listen(fac);
  const { server, base } = await appWith(facBase);
  t.after(() => { server.close(); fac.close(); });

  const { paymentTicket } = await (await fetch(`${base}/feed`)).json();
  const header = payHeader("b".repeat(64), paymentTicket);

  assert.strictEqual((await fetch(`${base}/feed`, { headers: { "X-PAYMENT": header } })).status, 200);
  const second = await fetch(`${base}/feed`, { headers: { "X-PAYMENT": header } });
  assert.strictEqual(second.status, 402);
  assert.strictEqual((await second.json()).error, "payment_already_used");
});

test("an unreachable facilitator says so instead of serving an unpayable 402", async (t) => {
  const { server, base } = await appWith("http://127.0.0.1:1");
  t.after(() => server.close());
  const res = await fetch(`${base}/feed`);
  assert.strictEqual(res.status, 503);
  assert.strictEqual((await res.json()).error, "facilitator_unreachable");
});

test("misconfiguration fails at startup, not on a buyer's request", () => {
  assert.throws(() => requirePayment({ ticketKey: KEY, amount: 1 }), /sellerId/);
  assert.throws(() => requirePayment({ sellerId: SELLER, amount: 1 }), /ticketKey/);
  assert.throws(() => requirePayment({ sellerId: SELLER, ticketKey: KEY }), /amount/);
});

test("a ticket is scoped to one purchase", () => {
  const t1 = issueTicket(KEY, { sellerId: SELLER, resourceId: "/feed", amount: "20000" });
  assert.strictEqual(verifyTicket(KEY, t1.token, { sellerId: SELLER, resourceId: "/other", amount: "20000" }).reason, "ticket_wrong_resource");
  assert.strictEqual(verifyTicket(KEY, t1.token, { sellerId: SELLER, resourceId: "/feed", amount: "1" }).reason, "ticket_wrong_amount");
  assert.match(t1.nonceHex, /^[0-9a-f]{16}$/);
});

test("a contract facilitator that hides its address is refused, not guessed at", async (t) => {
  // Falling back to the seller here would mint a 402 whose payments the
  // facilitator can never verify - the buyer pays and is still refused.
  const fac = stubFacilitator({ settlement: { name: "contract", contractIndex: 29 } });
  const facBase = await listen(fac);
  const { server, base } = await appWith(facBase);
  t.after(() => { server.close(); fac.close(); });

  const res = await fetch(`${base}/feed`);
  assert.strictEqual(res.status, 503);
  assert.match((await res.json()).detail, /contractAddress/);
});
