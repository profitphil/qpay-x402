// signer.js - a signer that holds a Qubic seed and broadcasts transactions.
//
// THIS SPENDS QU ON ITS OWN. Anything holding the seed can move the whole
// balance: use a wallet funded only with what you mean to spend, and set the
// x402 client's spend controls (allowedAssets[].maxAmountPerPayment).
//
// Any object with the same two methods works as a signer - a hardware or
// custodial signer, a test double - so the seed never has to be here.

function seedSigner(seed, { rpcUrl = "https://rpc.qubic.org" } = {}) {
  if (typeof seed !== "string" || !/^[a-z]{55}$/.test(seed)) throw new Error("seedSigner needs a Qubic seed: 55 lowercase letters a-z");
  const base = rpcUrl.replace(/\/$/, "");
  let libs = null;
  const load = () => {
    if (!libs) {
      const { QubicHelper } = require("@qubic-lib/qubic-ts-library/dist/qubicHelper");
      const { QubicTransaction } = require("@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction");
      const { DynamicPayload } = require("@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload");
      libs = { helper: new QubicHelper(), QubicTransaction, DynamicPayload };
    }
    return libs;
  };
  let id = null;
  const identity = async () => (id = id || (await load().helper.createIdPackage(seed)));

  return {
    async address() {
      return (await identity()).publicId;
    },
    /** Signs and broadcasts one transaction; resolves to its id. */
    async send({ to, amount, inputType, input, tick }) {
      const { QubicTransaction, DynamicPayload } = load();
      const tx = new QubicTransaction()
        .setSourcePublicKey((await identity()).publicId)
        .setDestinationPublicKey(to)
        .setAmount(Number(amount))
        .setTick(tick)
        .setInputType(inputType)
        .setInputSize(input ? input.length : 0);
      if (input && input.length) {
        const payload = new DynamicPayload(input.length);
        payload.setPayload(input);
        tx.setPayload(payload);
      }
      await tx.build(seed);
      const res = await fetch(`${base}/v1/broadcast-transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encodedTransaction: tx.encodeTransactionToBase64(tx.getPackageData()) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`broadcast failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return tx.getId();
    },
  };
}

module.exports = { seedSigner };
