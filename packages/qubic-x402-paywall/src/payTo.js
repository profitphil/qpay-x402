// Where a buyer actually sends the money.
//
// Under QPAY contract settlement that is the CONTRACT, not you: it takes
// the protocol fee and forwards the net to you in the same transaction, so
// you never give up custody but the address on the 402 is the contract's.
// Under direct settlement it is your own address.
//
// The facilitator publishes the finished address in /supported, so this
// package needs no Qubic library and no identity encoding of its own -
// which also means a client in any language can do exactly what this does:
// read one field.

/**
 * @param {object} client   a facilitator client
 * @param {string} sellerId your address - used when settlement is direct
 */
/** "contract" or "direct" - what the facilitator settles through. */
async function settlementName(client) {
  const info = await client.supported();
  return ((info && info.settlement) || {}).name === "contract" ? "contract" : "direct";
}

async function resolvePayTo(client, sellerId) {
  const info = await client.supported();
  const settlement = (info && info.settlement) || {};
  if (settlement.name !== "contract") return sellerId;

  if (!settlement.contractAddress) {
    // Refuse rather than guess. Paying the seller directly under a contract
    // facilitator would produce a payment it can never verify: the buyer's
    // money is gone and the resource is still refused.
    throw new Error(
      "facilitator settles through a contract but did not publish contractAddress - " +
        "it needs updating, or pass payTo explicitly"
    );
  }
  return settlement.contractAddress;
}

/**
 * The network the facilitator settles on: qubic:mainnet, or qubic:sandbox for
 * the sandbox at sandbox.useqpay.com. A facilitator that predates the field
 * is a mainnet one.
 */
async function networkName(client) {
  const info = await client.supported();
  const kind = ((info && info.kinds) || []).find((k) => k && k.scheme === "exact");
  return (kind && kind.network) || "qubic:mainnet";
}

module.exports = { resolvePayTo, settlementName, networkName };
