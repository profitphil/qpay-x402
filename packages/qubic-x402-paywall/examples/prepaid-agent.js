// examples/prepaid-agent.js
//
// An agent that pays an x402 endpoint through a PREPAID CHANNEL: one deposit
// (through the QPAY contract, or straight to the seller where the facilitator
// settles directly, as the sandbox does), then a voucher signed by its own
// key for each call - no transaction per call. Point it at any endpoint whose 402 carries
// a `channel` offer.
//
//   npm install @qubic-lib/qubic-ts-library
//   QUBIC_SEED=... node prepaid-agent.js https://useqpay.com/x402/demo/prepaid 5
//
// Environment:
//   QUBIC_SEED    the paying wallet's 55-letter seed (never leaves this process)
//   MAX_DEPOSIT   refuse a deposit larger than this, in QU (default 100000)
//   MAX_PRICE     refuse a price per call larger than this, in QU (default 10000)
//   DRY_RUN=1     show the offer and stop before paying anything
//   QUBIC_RPC_URL defaults to https://rpc.qubic.org
//
// The spec this follows: "Prepaid channels" at https://useqpay.com/docs/x402

const nodeCrypto = require("crypto");

const RPC = (process.env.QUBIC_RPC_URL || "https://rpc.qubic.org").replace(/\/$/, "");
const PROC_PAY = 1; // QPAY.Pay
const QPAY_CONTRACT = "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH";
const TICK_OFFSET = 30; // how far ahead to schedule the deposit (~0.6s a tick)

async function loadQubic() {
  const { default: cryptoPromise } = require("@qubic-lib/qubic-ts-library/dist/crypto");
  const { KeyHelper } = require("@qubic-lib/qubic-ts-library/dist/keyHelper");
  const { QubicHelper } = require("@qubic-lib/qubic-ts-library/dist/qubicHelper");
  const { QubicTransaction } = require("@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction");
  const { DynamicPayload } = require("@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload");
  const { schnorrq, K12 } = await cryptoPromise;
  return { schnorrq, K12, keyHelper: new KeyHelper(), helper: new QubicHelper(), QubicTransaction, DynamicPayload };
}

/** The wallet: its address, a voucher signer, and a deposit payer. */
async function wallet(seed) {
  const q = await loadQubic();
  const id = await q.helper.createIdPackage(seed);
  const address = id.publicId;
  const privateKey = q.keyHelper.privateKey(seed, 0, q.K12);
  const publicKey = q.helper.getIdentityBytes(address); // the clean 32-byte key

  /** SchnorrQ over KangarooTwelve-256 of the UTF-8 message, as 128 hex characters. */
  function sign(message) {
    const digest = new Uint8Array(32);
    q.K12(Buffer.from(message, "utf8"), digest, 32);
    return Buffer.from(q.schnorrq.sign(privateKey, publicKey, digest)).toString("hex");
  }

  /** QPAY.Pay input: seller key (32) | SHA-256(resourceId) (32) | ticket nonce, 8 bytes as written. */
  function payInput(sellerId, resourceId, nonceHex) {
    return Buffer.concat([
      Buffer.from(q.helper.getIdentityBytes(sellerId)),
      nodeCrypto.createHash("sha256").update(resourceId, "utf8").digest(),
      Buffer.from(nonceHex, "hex"),
    ]);
  }

  /**
   * The deposit, paid the way the 402 says: under "contract" a QPAY.Pay call
   * (refused unless payTo really is the QPAY contract - QU sent there with a
   * Pay input from anywhere else is lost), under "direct" a plain transfer to
   * payTo carrying the ticket's nonce.
   */
  async function payDeposit({ settlement, payTo, sellerId, amount, nonceHex }) {
    let input;
    let inputType;
    if (settlement === "contract") {
      if (payTo !== QPAY_CONTRACT) throw new Error(`contract settlement to ${payTo}, which is not the QPAY contract; nothing was paid`);
      input = payInput(sellerId, "channel:open", nonceHex);
      inputType = PROC_PAY;
    } else if (settlement === "direct") {
      input = Buffer.from(nonceHex, "hex");
      inputType = 0;
    } else {
      throw new Error(`unknown settlement "${settlement}"; nothing was paid`);
    }
    const payload = new q.DynamicPayload(input.length);
    payload.setPayload(input);
    const info = await (await fetch(`${RPC}/v1/tick-info`)).json();
    const tx = new q.QubicTransaction()
      .setSourcePublicKey(address)
      .setDestinationPublicKey(payTo)
      .setAmount(Number(amount))
      .setTick(info.tickInfo.tick + TICK_OFFSET)
      .setInputType(inputType)
      .setInputSize(input.length);
    tx.setPayload(payload);
    await tx.build(seed);
    const res = await fetch(`${RPC}/v1/broadcast-transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encodedTransaction: tx.encodeTransactionToBase64(tx.getPackageData()) }),
    });
    if (!res.ok) throw new Error(`broadcast failed: HTTP ${res.status} ${await res.text()}`);
    return tx.getId();
  }

  return { address, sign, payInput, payDeposit };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const nonceOf = (ticket) => JSON.parse(Buffer.from(ticket.slice(0, ticket.lastIndexOf(".")), "base64url").toString()).nonce;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [url, callsArg] = process.argv.slice(2);
  if (!url || !process.env.QUBIC_SEED) {
    console.error("usage: QUBIC_SEED=... node prepaid-agent.js <url> [calls]");
    process.exit(2);
  }
  const calls = Number(callsArg) || 3;
  const maxDeposit = BigInt(process.env.MAX_DEPOSIT || 100000);
  const maxPrice = BigInt(process.env.MAX_PRICE || 10000);
  const me = await wallet(process.env.QUBIC_SEED.trim());
  console.log(`wallet ${me.address}`);

  let pendingOpen = null; // a paid deposit not yet accepted: resent, never paid twice

  for (let n = 1; n <= calls; n++) {
    const first = await fetch(url);
    if (first.status !== 402) {
      console.log(`call ${n}: ${first.status} without paying`, await first.text());
      continue;
    }
    const offer = (await first.json()).channel;
    if (!offer) throw new Error("this endpoint's 402 offers no prepaid channel");
    const sellerId = offer.requirements.extra.sellerId;
    const price = BigInt(offer.price);
    const channelId = `${me.address}:${sellerId}`;
    if (price > maxPrice) throw new Error(`price ${price} QU is over MAX_PRICE`);

    // Where the channel stands, from the facilitator.
    const bal = await fetch(`${offer.balanceUrl}/${encodeURIComponent(channelId)}`);
    let ch = bal.status === 404 ? null : await bal.json();
    if (n === 1) console.log(`offer: ${offer.price} QU a call from a ${offer.deposit} QU deposit; channel ${ch ? `has ${ch.remaining} QU left` : "not opened yet"}`);

    if (!pendingOpen && (!ch || BigInt(ch.remaining) < price)) {
      if (BigInt(offer.deposit) > maxDeposit) throw new Error(`deposit ${offer.deposit} QU is over MAX_DEPOSIT`);
      if (process.env.DRY_RUN) {
        console.log("DRY_RUN: would pay", offer.deposit, "QU to", offer.requirements.payTo, "for seller", sellerId);
        return;
      }
      const txId = await me.payDeposit({
        settlement: offer.requirements.extra.settlement || "direct",
        payTo: offer.requirements.payTo,
        sellerId,
        amount: offer.deposit,
        nonceHex: nonceOf(offer.ticket),
      });
      console.log(`deposit: ${offer.deposit} QU sent, transaction ${txId}`);
      pendingOpen = b64({ x402Version: 2, accepted: offer.requirements, payload: { txHash: txId, ticket: offer.ticket } });
    }

    let resynced = false;
    for (let attempt = 1; ; attempt++) {
      const cumulative = ((ch ? BigInt(ch.spent) : 0n) + price).toString();
      const headers = { "X-CHANNEL-VOUCHER": b64({ channelId, cumulativeAmount: cumulative, signature: me.sign(`channel:${channelId}:${cumulative}`) }) };
      if (pendingOpen) headers["X-CHANNEL-OPEN"] = pendingOpen;
      const res = await fetch(url, { headers });
      if (res.ok) {
        pendingOpen = null;
        console.log(`call ${n}: ${res.status}, ${res.headers.get("X-CHANNEL-REMAINING")} QU left`, await res.text());
        break;
      }
      const err = await res.json().catch(() => ({}));
      if (pendingOpen && err.error === "invalid_transaction_state" && attempt < 60) {
        if (attempt === 1) process.stdout.write("waiting for the deposit to confirm");
        process.stdout.write(".");
        await sleep(3000);
        continue;
      }
      if (err.channelState && !resynced) {
        resynced = true; // out of step with the facilitator: take its numbers, sign once more
        ch = err.channelState;
        continue;
      }
      throw new Error(`call ${n} refused: ${res.status} ${err.error || ""}`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n${e.message}`);
    process.exit(1);
  });
}
module.exports = { wallet };
