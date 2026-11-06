// Opt-in, needs the network: QPAY_SANDBOX_TESTS=1 npm test -w x402-qubic.
// Pays the Q+Pay sandbox's prepaid demo with a throwaway seed (test QU only):
// one deposit, then calls by voucher.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createChannelFetch, seedSigner, QUBIC_SANDBOX } = require("..");

const RPC = "https://sandbox.useqpay.com/rpc";

test("prepaid channel on the sandbox: one deposit, three calls", { skip: !process.env.QPAY_SANDBOX_TESTS, timeout: 180_000 }, async () => {
  const seed = Array.from({ length: 55 }, () => String.fromCharCode(97 + crypto.randomInt(26))).join("");
  const signer = seedSigner(seed, { rpcUrl: RPC });
  const channelFetch = createChannelFetch({ signer, network: QUBIC_SANDBOX, rpcUrl: RPC, maxDeposit: 10000, maxPricePerCall: 1000 });
  const remaining = [];
  for (let i = 0; i < 3; i++) {
    const res = await channelFetch("https://sandbox.useqpay.com/x402/demo/prepaid");
    assert.equal(res.status, 200, await res.clone().text());
    remaining.push(res.headers.get("X-CHANNEL-REMAINING"));
  }
  assert.deepEqual(remaining, ["9000", "8000", "7000"]);
});
