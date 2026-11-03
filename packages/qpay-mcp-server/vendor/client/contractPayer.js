// client/contractPayer.js
//
// A buyer that pays through the QPAY contract instead of transferring
// straight to the seller.
//
// WHAT CHANGES FROM THE DIRECT PAYER. Under direct settlement the buyer
// sends a plain transfer to the seller with the ticket's nonce in the memo,
// and the reference handed back is the transaction id. Under the contract
// the buyer invokes QPAY.Pay{seller, resourceTag, nonce} with the price
// attached: the contract takes the 0.75% fee, forwards the net to the
// seller in the same transaction, and records a receipt. The reference is
// then the RECEIPT KEY - K12(payer, seller, resourceTag, nonce) - not a
// transaction id, because the receipt is what the facilitator reads back
// out of contract state.
//
// Custody is unchanged: the net reaches the seller inside the Pay call. The
// contract never holds a merchant's money between transactions.
//
// The receipt key is computed BY THE CONTRACT (ComputeReceiptKey, a pure
// read-only function) rather than reimplemented here. K12 over a packed
// struct is exactly the kind of thing that silently disagrees across
// implementations, and a key that disagrees means a real payment that
// cannot be verified - the buyer's money is gone and the resource is
// refused. Asking the contract costs one RPC round trip and removes the
// whole class of error.

const {
  CONTRACT_INDEX,
  FUNC_COMPUTE_RECEIPT_KEY,
  querySmartContract,
  contractIdentity,
  getCurrentTick,
} = require("../settlement/qpayRpc");
const {
  identityToBytes,
  resourceTag,
  encodePayInput,
  encodeComputeReceiptKeyInput,
  decodeComputeReceiptKeyOutput,
} = require("../settlement/qubicStructs");

// QPAY.Pay is registered as user procedure 1 (see Qpay.h's
// REGISTER_USER_FUNCTIONS_AND_PROCEDURES).
const PROC_PAY = 1;

async function load() {
  const { QubicHelper } = await import("@qubic-lib/qubic-ts-library/dist/qubicHelper.js");
  const { QubicTransaction } = await import("@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js");
  const { DynamicPayload } = await import("@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js");
  return { helper: new QubicHelper(), QubicTransaction, DynamicPayload };
}

/**
 * @param {string} seed        the buyer's 55-character seed
 * @param {number} tickOffset  how far ahead to target, same as seedPayer
 */
function contractPayer({ seed, tickOffset = 30, rpcUrl }) {
  return {
    name: "contract",
    /**
     * @param {string} payTo      ignored: a contract payment always goes to
     *                            the contract. Accepted so this payer is a
     *                            drop-in for the direct one.
     * @param {string} sellerId   who the money is FOR
     * @param {string} resourceId the resource being bought, as the 402 gave it
     * @param {string} nonceHex   16 hex chars from the ticket
     * @returns {{ reference: string, txId: string }}
     */
    async pay({ amount, sellerId, resourceId, nonceHex }) {
      if (!sellerId) throw new Error("contractPayer needs sellerId (the 402's extra.sellerId)");
      if (!/^[0-9a-f]{16}$/.test(String(nonceHex || ""))) {
        throw new Error("contractPayer needs the ticket's 16-hex-character nonce");
      }

      const { helper, QubicTransaction, DynamicPayload } = await load();
      const idPackage = await helper.createIdPackage(seed);

      const sellerBytes = identityToBytes(sellerId);
      const tagBytes = resourceTag(resourceId);
      // The contract reads the nonce as a little-endian uint64; the ticket
      // carries it as hex. Convert once, here, and use the same value for
      // both the payment and the receipt key so they cannot drift apart.
      const nonce = Buffer.from(nonceHex, "hex").readBigUInt64LE(0);

      const input = encodePayInput({ seller: sellerBytes, resourceId: tagBytes, nonce });
      const payload = new DynamicPayload(input.length);
      payload.setPayload(input);

      const contract = await contractIdentity();
      const tick = await getCurrentTick();

      const tx = new QubicTransaction()
        .setSourcePublicKey(idPackage.publicId)
        .setDestinationPublicKey(contract)
        .setAmount(amount)
        .setTick(tick + tickOffset)
        .setInputType(PROC_PAY)
        .setInputSize(input.length);
      tx.setPayload(payload);

      await tx.build(seed);
      const txId = tx.getId();

      const base = (rpcUrl || process.env.QUBIC_RPC_URL || "https://rpc.qubic.org").replace(/\/$/, "");
      const res = await fetch(`${base}/v1/broadcast-transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encodedTransaction: tx.encodeTransactionToBase64(tx.getPackageData()) }),
      });
      if (!res.ok) {
        throw new Error(`broadcast failed: HTTP ${res.status}`);
      }

      // Ask the contract for the key rather than computing it here.
      const keyBytes = decodeComputeReceiptKeyOutput(
        await querySmartContract(
          FUNC_COMPUTE_RECEIPT_KEY,
          encodeComputeReceiptKeyInput({
            payer: identityToBytes(idPackage.publicId),
            seller: sellerBytes,
            resourceId: tagBytes,
            nonce,
          })
        )
      );
      if (!keyBytes) throw new Error("contract did not return a receipt key");

      return { reference: keyBytes.toString("hex"), txId, contractIndex: CONTRACT_INDEX };
    },

    /** Signs a prepaid-channel voucher with this wallet's key (see prepaidFetch.js). */
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

module.exports = { contractPayer };
