// client/payers.js
//
// A payer answers one question: "send this amount to this address, and tell
// me the transaction id." Everything else about x402 lives in x402Fetch.js,
// so the same client works whether payment comes from a raw seed, a CLI, a
// hardware wallet, or a human pasting a tx id.
//
//   { async pay({ payTo, amount, asset, network, resourceId, url }) -> { txId } }
//
// Three are shipped here. seedPayer is the only one that moves money on its
// own, and it is the one to be careful with.

const readline = require("readline");

const RPC_URL = (process.env.QUBIC_RPC_URL || "https://rpc.qubic.org").replace(/\/$/, "");
const RPC_TIMEOUT_MS = Number(process.env.QUBIC_RPC_TIMEOUT_MS || 20000);

// Opt-in per-step timing for seedPayer. Off by default (a payer moving real
// money should be quiet); set QUBIC_PAYER_DEBUG=1 to see which specific step
// - key derivation, a tick read, signing, or the broadcast itself - is slow,
// rather than guessing across another live broadcast when something times out.
const DEBUG = process.env.QUBIC_PAYER_DEBUG === "1";
async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    if (DEBUG) console.error(`  [seedPayer] ${label}: ${Date.now() - t0}ms`);
    return result;
  } catch (e) {
    if (DEBUG) console.error(`  [seedPayer] ${label}: FAILED after ${Date.now() - t0}ms - ${e.message}`);
    throw e;
  }
}

async function rpc(path, init) {
  const res = await fetch(`${RPC_URL}${path}`, {
    headers: { "Content-Type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    ...init,
  });
  if (!res.ok) throw new Error(`Qubic RPC ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function currentTick() {
  const body = await rpc("/v1/tick-info");
  const tick = body && body.tickInfo && body.tickInfo.tick;
  if (typeof tick !== "number") throw new Error("could not read current tick");
  return tick;
}

/**
 * Signs and broadcasts with a seed, using the official @qubic-lib/qubic-ts-library.
 *
 * THIS SPENDS REAL QU AUTONOMOUSLY. The seed is a spending key: anything
 * holding it can move the whole balance. Treat it like a private key, keep it
 * in a wallet funded with only what you intend to spend, and rely on
 * x402Fetch's maxAmountPerCall / maxTotalSpend as the backstop - a server
 * decides the price, so those limits are the only thing bounding what a
 * compromised or buggy endpoint can extract.
 *
 * The transaction is built and signed by the official library rather than by
 * hand: encoding a Qubic transfer incorrectly is an excellent way to lose
 * funds silently, and that library is the tested path.
 *
 * TICK FRESHNESS. A Qubic transaction targets a specific future tick and is
 * only valid if it reaches the network before that tick arrives; Qubic ticks
 * currently run at well under half a second each (measured ~0.34s/tick on
 * mainnet), so a stale target is a real risk, not a theoretical one - a
 * single live run of this exact code broadcast successfully (HTTP 200 from
 * broadcast-transaction, which only confirms relay, not tick validity) and
 * then never appeared on chain, because the default 5-tick offset (~1.7s)
 * left less margin than signing + network latency actually cost. The
 * checkpoint below re-reads the tick immediately before broadcasting and
 * rebuilds with a fresh target if too little headroom remains, retrying a
 * bounded number of times rather than gambling once.
 *
 * Requires: npm install @qubic-lib/qubic-ts-library
 */
function seedPayer({ seed, tickOffset = 30, minHeadroomTicks = 5, maxAttempts = 4, rpcUrl }) {
  if (!seed || typeof seed !== "string") {
    throw new Error("seedPayer requires a seed");
  }
  const base = (rpcUrl || RPC_URL).replace(/\/$/, "");

  let libs = null;
  async function load() {
    if (libs) return libs;
    let QubicHelper, QubicTransaction, DynamicPayload;
    try {
      ({ QubicHelper } = require("@qubic-lib/qubic-ts-library/dist/qubicHelper"));
      ({ QubicTransaction } = require("@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction"));
      ({ DynamicPayload } = require("@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload"));
    } catch (e) {
      throw new Error(
        "seedPayer needs @qubic-lib/qubic-ts-library. Install it with: npm install @qubic-lib/qubic-ts-library"
      );
    }
    libs = { helper: new QubicHelper(), QubicTransaction, DynamicPayload };
    return libs;
  }

  return {
    name: "seed",
    // nonceHex: the payment ticket's server-issued nonce (see
    // paymentTicket.js). Embedded as the transfer's memo/payload so the
    // facilitator can bind this specific on-chain payment to the specific
    // private 402 response it was issued in - without it, a tx hash alone
    // is a public bearer credential anyone watching the chain could redeem
    // first. Omit only against a facilitator that doesn't require one.
    async pay({ payTo, amount, nonceHex }) {
      const { helper, QubicTransaction, DynamicPayload } = await load();
      const idPackage = await timed("createIdPackage", () => helper.createIdPackage(seed));

      let payload = null;
      let inputSize = 0;
      if (nonceHex) {
        const nonceBytes = Buffer.from(nonceHex, "hex");
        payload = new DynamicPayload(nonceBytes.length);
        payload.setPayload(nonceBytes);
        inputSize = nonceBytes.length;
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const tick = await timed(`currentTick (attempt ${attempt})`, currentTick);
        const targetTick = tick + tickOffset;

        const tx = new QubicTransaction()
          .setSourcePublicKey(idPackage.publicId)
          .setDestinationPublicKey(payTo)
          .setAmount(amount)
          .setTick(targetTick)
          .setInputType(0)
          .setInputSize(inputSize);
        if (payload) tx.setPayload(payload);

        const signed = await timed(`tx.build (attempt ${attempt})`, () => tx.build(seed));
        // getId() is the id the network will know this transaction by; read
        // it after build() so it covers the signed package.
        const txId = tx.getId();

        // Checkpoint: has signing eaten enough of the margin that this
        // target is already unsafe to broadcast? If so, don't send a
        // transaction that is likely to be silently dropped - get a fresh
        // tick and rebuild instead of gambling on a stale one.
        const freshTick = await timed(`checkpoint tick (attempt ${attempt})`, currentTick);
        if (targetTick - freshTick < minHeadroomTicks) {
          if (attempt === maxAttempts) {
            throw new Error(
              `seedPayer: could not get enough tick headroom after ${maxAttempts} attempts ` +
                `(network or signing is slower than the margin allows). Not broadcasting a ` +
                `transaction likely to be dropped.`
            );
          }
          continue; // retry with a freshly-read tick
        }

        await timed(`broadcast (attempt ${attempt})`, () =>
          fetch(`${base}/v1/broadcast-transaction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ encodedTransaction: Buffer.from(signed).toString("base64") }),
            signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          }).then(async (r) => {
            if (!r.ok) throw new Error(`broadcast failed: HTTP ${r.status} ${await r.text()}`);
          })
        );

        return { txId, tick: targetTick, from: idPackage.publicId };
      }
    },

    // Signs an arbitrary message with this seed's key - the payment-channel
    // path (channelFetch.js) uses this to authorize a voucher without any
    // on-chain transaction. Delegates to channelCrypto.js rather than
    // re-deriving keys here, since that module is where the "public key
    // representation must be exactly 32 bytes, consistently, on both the
    // signing and verifying side" subtlety is handled - duplicating key
    // derivation here would risk drifting from that.
    async signVoucher(message) {
      const { deriveKeys, signMessage } = require("../channelCrypto");
      const keys = await deriveKeys(seed);
      return { signature: await signMessage(keys, message), address: keys.address };
    },

    /** This wallet's address - a prepaid channel's id starts with it. */
    async address() {
      const { deriveKeys } = require("../channelCrypto");
      return (await deriveKeys(seed)).address;
    },
  };
}

/**
 * Asks a human to pay and paste the tx id. No keys, no autonomy - useful for
 * testing the whole flow, and for a CLI where a person is present anyway.
 *
 * KNOWN LIMITATION: this payer cannot embed the anti-front-running nonce
 * (see paymentTicket.js) into the transfer, since it doesn't construct the
 * transaction - whatever external wallet/tool the human uses does, and most
 * simple "send QU" flows don't expose a memo field. The facilitator will
 * still reject the payment if it can't find a matching nonce on-chain once
 * a route requires one. If your tooling supports an arbitrary transaction
 * payload/memo, embed nonceHex there yourself; otherwise this payer is only
 * safe against a facilitator that doesn't enforce nonce-binding.
 */
function manualPayer({ input = process.stdin, output = process.stdout } = {}) {
  return {
    name: "manual",
    async pay({ payTo, amount, asset, nonceHex }) {
      const rl = readline.createInterface({ input, output });
      output.write(`\nPayment required: send exactly ${amount} ${asset || "QU"} to\n  ${payTo}\n`);
      if (nonceHex) {
        output.write(
          `\nThis facilitator requires the payment to carry a memo matching:\n  ${nonceHex}\n` +
            `If your wallet/tool can't attach an arbitrary memo to a transfer, this payment\n` +
            `will be rejected - see the KNOWN LIMITATION note on manualPayer.\n`
        );
      }
      const txId = await new Promise((resolve) =>
        rl.question("Paste the transaction id: ", (a) => {
          rl.close();
          resolve(a.trim());
        })
      );
      return { txId };
    },
  };
}

/**
 * Delegates to a caller-supplied function. The escape hatch for a wallet
 * adapter, a hardware signer, an internal treasury service, or a test double.
 */
function customPayer(fn, name = "custom") {
  if (typeof fn !== "function") throw new Error("customPayer requires a function");
  return {
    name,
    async pay(request) {
      const result = await fn(request);
      if (typeof result === "string") return { txId: result };
      return result;
    },
  };
}

module.exports = { seedPayer, manualPayer, customPayer };
