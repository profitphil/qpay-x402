// ExactQubicScheme on its own: what it signs, what it refuses before
// signing, and how it decides a payment executed or was dropped. A stand-in
// Qubic RPC answers tick-info, the indexer's status and transaction lookups;
// the signer is a test double. No network, no dependencies beyond Node.
//
//   node --test packages/x402-qubic/test/*.test.js

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const crypto = require("crypto");
const { ExactQubicScheme, QUBIC_MAINNET, QUBIC_SANDBOX, QPAY_CONTRACT_ADDRESS } = require("..");
const { identityToBytes } = require("../src/scheme");

const SELLER = "QPAYNOWSWZMGHFEAEVJXGZAVSHABAZDDBDIHTEBOPCOGHRGBCYCUZOHCVLXG";
const NONCE = "0123456789abcdef";

// --- Stand-in RPC -------------------------------------------------------------

const rpc = {
  tick: 1000, // live tick; advances on every tick-info and status read
  indexerLag: 0, // how far the indexer runs behind it
  statusDown: false,
  indexed: new Set(), // transactions the indexer can find
  moneyFlew: true,
};
let rpcUrl;
const server = http.createServer((req, res) => {
  const send = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const m = req.url.match(/^\/v2\/transactions\/(.+)$/);
  const s = req.url.match(/^\/v1\/tx-status\/(.+)$/);
  if (req.url === "/v1/tick-info") return send(200, { tickInfo: { tick: (rpc.tick += 5) } });
  if (req.url === "/v1/status") {
    if (rpc.statusDown) return send(503, {});
    return send(200, { lastProcessedTick: { tickNumber: (rpc.tick += 5) - rpc.indexerLag } });
  }
  if (m) return rpc.indexed.has(m[1]) ? send(200, { transaction: { txId: m[1] } }) : send(404, { code: 5 });
  if (s) return send(200, { transactionStatus: { txId: s[1], moneyFlew: rpc.moneyFlew } });
  send(404, {});
});
test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", () => { rpcUrl = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => new Promise((r) => server.close(r)));
test.beforeEach(() => Object.assign(rpc, { indexerLag: 0, statusDown: false, moneyFlew: true }));

// --- Helpers -------------------------------------------------------------------

/** A signer double: records what it was asked to sign; the indexer finds it after `indexAfterMs` (never if null). */
function signer({ indexAfterMs = 0 } = {}) {
  const sent = [];
  return {
    sent,
    address: async () => "B".repeat(60),
    async send(tx) {
      sent.push(tx);
      const id = crypto.randomBytes(30).toString("hex").replace(/[0-9]/g, (d) => "abcdefghij"[d]).slice(0, 60);
      if (indexAfterMs != null) setTimeout(() => rpc.indexed.add(id), indexAfterMs);
      return id;
    },
  };
}

const ticket = ({ resourceId = "/feed", amount = "20000", exp = Math.floor(Date.now() / 1000) + 600, sellerId = SELLER } = {}) =>
  Buffer.from(JSON.stringify({ v: "pt1", sellerId, resourceId, amount, nonce: NONCE, iat: 1, exp })).toString("base64url") + ".sig";

function option({ settlement = "direct", payTo, amount = "20000", network = QUBIC_MAINNET, extra = {}, ticketOpts = {} } = {}) {
  return {
    scheme: "exact", network, amount, asset: "QUBIC",
    payTo: payTo || (settlement === "contract" ? QPAY_CONTRACT_ADDRESS : SELLER),
    maxTimeoutSeconds: 120,
    extra: { sellerId: SELLER, resourceId: "/feed", settlement, paymentTicket: ticket({ amount, ...ticketOpts }), ...extra },
  };
}

const scheme = (sig, opts = {}) => new ExactQubicScheme({ signer: sig, rpcUrl, pollMs: 10, confirmTimeoutMs: 5000, ...opts });
const pay = (sig, opt, opts, context = {}) => scheme(sig, opts).createPaymentPayload(2, opt, context);
const refused = (code) => (err) => err.code === code;

// --- What it signs ---------------------------------------------------------------

test("direct: a transfer of the price to payTo carrying the ticket's nonce", async () => {
  const sig = signer();
  const opt = option();
  const out = await pay(sig, opt);
  assert.deepStrictEqual(out.payload.ticket, opt.extra.paymentTicket);
  const [tx] = sig.sent;
  assert.deepStrictEqual([tx.to, tx.amount, tx.inputType, tx.input.toString("hex")], [SELLER, 20000n, 0, NONCE]);
});

test("contract: a QPAY Pay call, seller || SHA-256(resourceId) || nonce", async () => {
  const sig = signer();
  await pay(sig, option({ settlement: "contract" }));
  const [tx] = sig.sent;
  const expected = Buffer.concat([identityToBytes(SELLER), crypto.createHash("sha256").update("/feed").digest(), Buffer.from(NONCE, "hex")]);
  assert.deepStrictEqual([tx.to, tx.inputType], [QPAY_CONTRACT_ADDRESS, 1]);
  assert.strictEqual(tx.input.toString("hex"), expected.toString("hex"));
});

// --- What it refuses before signing ------------------------------------------------

test("refusals happen before anything is signed", async (t) => {
  const cases = [
    ["another network", option({ network: "eip155:1" }), "unsupported_requirements"],
    ["a contract payment to anything but the QPAY contract", option({ settlement: "contract", payTo: SELLER }), "unknown_contract"],
    ["contract settlement without a resourceId", option({ settlement: "contract", extra: { resourceId: undefined }, ticketOpts: { resourceId: undefined } }), "resource_missing"],
    ["a ticket for a different amount", option({ ticketOpts: { amount: "1" } }), "ticket_mismatch"],
    ["a ticket that expires before the payment could settle", option({ ticketOpts: { exp: Math.floor(Date.now() / 1000) + 20 } }), "ticket_expired"],
    ["an unknown settlement", option({ settlement: "teleport" }), "unsupported_settlement"],
  ];
  for (const [name, opt, code] of cases) {
    await t.test(name, async () => {
      const sig = signer();
      await assert.rejects(pay(sig, opt), refused(code));
      assert.strictEqual(sig.sent.length, 0, "nothing was signed");
    });
  }
});

test("a price over the client's spend cap is refused before signing", async () => {
  const sig = signer();
  await assert.rejects(pay(sig, option(), {}, { maxAmountPerPayment: "100" }), refused("spend_cap"));
  assert.strictEqual(sig.sent.length, 0);
});

// --- Executed, or dropped ------------------------------------------------------------

test("a payment the indexer is slow to show is waited for, not called dropped", async () => {
  rpc.indexerLag = 10_000; // the live tick races ahead; the indexer is far behind
  const out = await pay(signer({ indexAfterMs: 300 }), option());
  assert.ok(out.payload.txHash);
});

test("a payment is dropped only once the indexer is past its tick", async () => {
  await assert.rejects(pay(signer({ indexAfterMs: null }), option()), refused("payment_dropped"));
});

test("an indexer that does not report its progress never makes a payment dropped", async () => {
  rpc.statusDown = true;
  await assert.rejects(pay(signer({ indexAfterMs: null }), option(), { confirmTimeoutMs: 300 }), refused("confirm_timeout"));
});

test("a payment that executed but moved no QU fails without sending proof", async () => {
  rpc.moneyFlew = false;
  await assert.rejects(pay(signer(), option()), refused("payment_not_executed"));
});

// --- The RPC follows the network ------------------------------------------------------

test("a sandbox scheme defaults to the sandbox's RPC and refuses mainnet's", () => {
  const sig = signer();
  assert.strictEqual(new ExactQubicScheme({ signer: sig }).rpcUrl, "https://rpc.qubic.org");
  assert.strictEqual(new ExactQubicScheme({ signer: sig, network: QUBIC_SANDBOX }).rpcUrl, "https://sandbox.useqpay.com/rpc");
  assert.throws(() => new ExactQubicScheme({ signer: sig, network: QUBIC_SANDBOX, rpcUrl: "https://rpc.qubic.org/" }), /mainnet RPC/);
});
