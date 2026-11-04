const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createChannelFetch, seedSigner, QUBIC_SANDBOX, QPAY_CONTRACT_ADDRESS } = require("..");
const { BALANCE_URLS } = require("../src/channel");

const BALANCE_URL = BALANCE_URLS[QUBIC_SANDBOX];
const URL_API = "https://api.example.com/quote";

function randomSeed() {
  return Array.from({ length: 55 }, () => String.fromCharCode(97 + crypto.randomInt(26))).join("");
}

async function lib() {
  const { default: c } = require("@qubic-lib/qubic-ts-library/dist/crypto");
  const { QubicHelper } = require("@qubic-lib/qubic-ts-library/dist/qubicHelper");
  return { ...(await c), helper: new QubicHelper() };
}

async function verify(buyer, message, signatureHex) {
  const { K12, schnorrq, helper } = await lib();
  const digest = new Uint8Array(32);
  K12(Buffer.from(message, "utf8"), digest, 32);
  return schnorrq.verify(helper.getIdentityBytes(buyer), digest, Buffer.from(signatureHex, "hex")) === 1;
}

function ticket(resourceId, amount, sellerId) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { v: "pt1", sellerId, resourceId, amount, nonce: "0123456789abcdef", iat: now, exp: now + 600 };
  return `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const decode = (v) => JSON.parse(Buffer.from(v, "base64").toString("utf8"));
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function setup(scenario = {}) {
  const real = seedSigner(randomSeed());
  const buyer = await real.address();
  const seller = await seedSigner(randomSeed()).address();
  const channelId = `${buyer}:${seller}`;
  const price = scenario.price ?? "1000";
  const deposit = scenario.deposit ?? "10000";
  const settlement = scenario.settlement ?? "direct";
  const state = { opened: false, deposit: 0n, spent: 0n };
  const sent = [];
  let pendingOpen = scenario.pendingOpen ?? 0;
  let txs = 0;
  let balanceReads = 0;
  let offers = 0;

  const offer = () => ({
    deposit,
    price,
    requirements: {
      scheme: "exact",
      network: QUBIC_SANDBOX,
      amount: deposit,
      asset: "QUBIC",
      // The first `badOffers` offers ask for a contract deposit to another address.
      payTo: offers++ < (scenario.badOffers ?? 0) ? seller : scenario.payTo ?? (settlement === "contract" ? QPAY_CONTRACT_ADDRESS : seller),
      maxTimeoutSeconds: 120,
      extra: { sellerId: seller, resourceId: "channel:open", settlement },
    },
    ticket: ticket("channel:open", deposit, seller),
    balanceUrl: scenario.balanceUrl ?? BALANCE_URL,
  });

  const net = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/rpc/v1/tick-info") return json(200, { tickInfo: { tick: 1000 } });
    // "drop-first": the first deposit never makes it on chain, and the indexer is past its tick.
    // "stuck": no deposit ever shows up, and the indexer does not say how far it is.
    if (url.pathname === "/rpc/v1/status" && scenario.chain === "drop-first") return json(200, { lastProcessedTick: { tickNumber: 5000 } });
    if (url.pathname.startsWith("/rpc/v2/transactions/")) {
      const id = url.pathname.split("/").pop();
      if (scenario.chain === "stuck" || (scenario.chain === "drop-first" && id === "tx1")) return new Response("", { status: 404 });
      return json(200, {});
    }
    if (url.pathname.startsWith("/rpc/v1/tx-status/")) return json(200, { transactionStatus: { moneyFlew: true } });
    if (`${url.origin}${url.pathname}`.startsWith(`${BALANCE_URL}/`)) {
      assert.equal(decodeURIComponent(url.pathname.split("/").pop()), channelId);
      balanceReads++;
      if (!state.opened) return new Response("", { status: 404 });
      // A lagging read reports nothing spent yet.
      const spent = (scenario.staleReads || []).includes(balanceReads) ? 0n : state.spent;
      return json(200, { deposit: state.deposit.toString(), spent: spent.toString(), remaining: (state.deposit - spent).toString() });
    }
    const headers = new Headers(init.headers);
    const open = headers.get("X-CHANNEL-OPEN");
    const voucher = headers.get("X-CHANNEL-VOUCHER");
    if (!voucher) return json(402, { x402Version: 2, accepts: [], channel: offer() });
    if (open) {
      if (pendingOpen-- > 0) return json(402, { error: "invalid_transaction_state" });
      const p = decode(open);
      assert.ok(p.payload.txHash);
      if (!state.opened || !state.seen?.has(p.payload.txHash)) {
        state.opened = true;
        state.deposit += BigInt(deposit);
        state.seen = (state.seen || new Set()).add(p.payload.txHash);
      }
    }
    const v = decode(voucher);
    const channelState = { spent: (scenario.lieInChannelState ?? state.spent).toString(), deposit: state.deposit.toString() };
    if (!state.opened) return json(402, { error: "channel_not_found" });
    const total = BigInt(v.cumulativeAmount);
    if (v.channelId !== channelId || !(await verify(buyer, `channel:${channelId}:${total}`, v.signature))) {
      return json(402, { error: "voucher_bad_signature", channelState });
    }
    if (total !== state.spent + BigInt(price)) return json(402, { error: "voucher_amount_mismatch", channelState });
    if (total > state.deposit) return json(402, { error: "voucher_exceeds_deposit", channelState });
    state.spent = total;
    return json(200, { quote: "ok" }, { "X-CHANNEL-REMAINING": (state.deposit - total).toString() });
  };

  const signer = {
    address: real.address,
    signVoucher: real.signVoucher,
    async send(tx) {
      sent.push(tx);
      return `tx${++txs}`;
    },
  };
  const channelFetch = createChannelFetch({
    signer,
    network: QUBIC_SANDBOX,
    rpcUrl: "https://sandbox.useqpay.com/rpc",
    maxDeposit: scenario.maxDeposit ?? 10000,
    maxPricePerCall: scenario.maxPricePerCall ?? 1000,
    maxTotalDeposits: scenario.maxTotalDeposits,
    fetch: net,
    schemeOptions: { pollMs: 1, confirmTimeoutMs: 50 },
    confirmIntervalMs: 1,
  });
  return { channelFetch, state, sent, buyer, seller, channelId, real };
}

test("opens a channel with one deposit, then pays each call by voucher", async () => {
  const { channelFetch, state, sent, seller } = await setup();
  for (let i = 0; i < 3; i++) {
    const res = await channelFetch(URL_API);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-CHANNEL-REMAINING"), String(10000 - 1000 * (i + 1)));
  }
  assert.equal(sent.length, 1);
  assert.deepEqual({ to: sent[0].to, amount: sent[0].amount, inputType: sent[0].inputType }, { to: seller, amount: 10000n, inputType: 0 });
  assert.equal(state.spent, 3000n);
});

test("pays a contract deposit as a QPAY Pay call", async () => {
  const { channelFetch, sent } = await setup({ settlement: "contract" });
  assert.equal((await channelFetch(URL_API)).status, 200);
  assert.equal(sent[0].to, QPAY_CONTRACT_ADDRESS);
  assert.equal(sent[0].inputType, 1);
});

test("refuses a contract deposit to anything but the QPAY contract, before signing", async () => {
  const evil = await setup({ settlement: "contract", payTo: await seedSigner(randomSeed()).address() });
  await assert.rejects(evil.channelFetch(URL_API), { code: "unknown_contract" });
  assert.equal(evil.sent.length, 0);
});

test("refuses a deposit above maxDeposit and a price above maxPricePerCall, before paying", async () => {
  const big = await setup({ deposit: "10001" });
  await assert.rejects(big.channelFetch(URL_API), { code: "limit_deposit" });
  assert.equal(big.sent.length, 0);
  const pricey = await setup({ price: "1001" });
  await assert.rejects(pricey.channelFetch(URL_API), { code: "limit_per_call" });
  assert.equal(pricey.sent.length, 0);
});

test("pays at most maxTotalDeposits over the client's life (one deposit by default)", async () => {
  const { channelFetch, sent } = await setup();
  for (let i = 0; i < 10; i++) await channelFetch(URL_API);
  await assert.rejects(channelFetch(URL_API), { code: "limit_total" });
  assert.equal(sent.length, 1);
  const topUps = await setup({ maxTotalDeposits: 20000 });
  for (let i = 0; i < 11; i++) await topUps.channelFetch(URL_API);
  assert.equal(topUps.sent.length, 2);
});

test("a deposit refused before signing does not use up the allowance", async () => {
  const { channelFetch, sent } = await setup({ settlement: "contract", badOffers: 1 });
  await assert.rejects(channelFetch(URL_API), { code: "unknown_contract" });
  assert.equal(sent.length, 0);
  // Still room for the one default deposit.
  assert.equal((await channelFetch(URL_API)).status, 200);
  assert.equal(sent.length, 1);
});

test("a dropped deposit gives the allowance back; one that may still land keeps it", async () => {
  const dropped = await setup({ chain: "drop-first" });
  await assert.rejects(dropped.channelFetch(URL_API), { code: "payment_dropped" });
  assert.equal((await dropped.channelFetch(URL_API)).status, 200);
  assert.equal(dropped.sent.length, 2);

  const stuck = await setup({ chain: "stuck" });
  await assert.rejects(stuck.channelFetch(URL_API), { code: "confirm_timeout" });
  await assert.rejects(stuck.channelFetch(URL_API), { code: "limit_total" });
  assert.equal(stuck.sent.length, 1);
});

test("refuses an offer whose deposit is below the price, before paying", async () => {
  const { channelFetch, sent } = await setup({ deposit: "500", price: "1000" });
  await assert.rejects(channelFetch(URL_API), { code: "invalid_offer" });
  assert.equal(sent.length, 0);
});

test("accepts the facilitator's balance URL with a trailing slash", async () => {
  const { channelFetch } = await setup({ balanceUrl: `${BALANCE_URL}/` });
  assert.equal((await channelFetch(URL_API)).status, 200);
});

test("ignores an offer whose balance URL is not the facilitator's", async () => {
  const { channelFetch, sent } = await setup({ balanceUrl: "https://evil.example.com/channel" });
  await assert.rejects(channelFetch(URL_API), { code: "untrusted_balance_url" });
  assert.equal(sent.length, 0);
});

test("a seller's channelState cannot make the client pay another deposit", async () => {
  // The seller claims the channel is spent; the facilitator is the only source used.
  const { channelFetch, sent } = await setup({ lieInChannelState: 10000n, maxTotalDeposits: 50000 });
  for (let i = 0; i < 3; i++) assert.equal((await channelFetch(URL_API)).status, 200);
  assert.equal(sent.length, 1);
});

test("resyncs from the facilitator once when its first answer was stale", async () => {
  // Reads: 1 before the deposit, 2 stale (says 0 spent), 3 after the refusal.
  const { channelFetch, state, sent } = await setup({ staleReads: [2] });
  assert.equal((await channelFetch(URL_API)).status, 200);
  assert.equal((await channelFetch(URL_API)).status, 200);
  assert.equal(state.spent, 2000n);
  assert.equal(sent.length, 1);
});

test("returns a 402 without a channel offer untouched", async () => {
  const net = async () => json(402, { x402Version: 2, accepts: [] });
  const { real } = await setup();
  const channelFetch = createChannelFetch({ signer: { ...real, signVoucher: real.signVoucher }, network: QUBIC_SANDBOX, maxDeposit: 1, maxPricePerCall: 1, fetch: net });
  assert.equal((await channelFetch(URL_API)).status, 402);
});

test("re-sends the same deposit while the facilitator has not seen it", async () => {
  const { channelFetch, sent } = await setup({ pendingOpen: 3 });
  assert.equal((await channelFetch(URL_API)).status, 200);
  assert.equal(sent.length, 1);
});

test("requires explicit limits and a signer that signs vouchers", () => {
  assert.throws(() => createChannelFetch({ signer: { address() {}, signVoucher() {} } }), { code: "limits_required" });
  assert.throws(() => createChannelFetch({ signer: { address() {} }, maxDeposit: 1, maxPricePerCall: 1 }), { code: "unsupported_signer" });
});

test("seedSigner.signVoucher signs only this wallet's own channel vouchers", async () => {
  const seed = randomSeed();
  const signer = seedSigner(seed);
  const me = await signer.address();
  const other = await seedSigner(randomSeed()).address();
  const sig = await signer.signVoucher(`channel:${me}:${other}:1000`);
  assert.match(sig, /^[0-9a-f]{128}$/);
  assert.ok(await verify(me, `channel:${me}:${other}:1000`, sig));
  for (const message of [`channel:${other}:${me}:1000`, `channel:${me}:${other}:0`, "hello", `channel:${me}:${other}:1000\n`]) {
    await assert.rejects(signer.signVoucher(message));
  }
});
