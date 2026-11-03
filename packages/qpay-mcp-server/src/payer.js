// payer.js
//
// One payer for every kind of Q+Pay endpoint, from the wallet's seed. A 402
// says how it settles: "contract" means a Pay call into the QPAY contract,
// which takes the fee and forwards the rest to the seller; "direct" means a
// plain transfer to the seller with the ticket's nonce attached. Sending a
// plain transfer to a contract-settled endpoint would strand the QU in the
// contract, so the choice is made per payment from what the 402 says, never
// from a setting.

const { seedPayer } = require("../vendor/client/payers");
const { contractPayer } = require("../vendor/client/contractPayer");

function walletPayer({ seed, rpcUrl }) {
  if (typeof seed !== "string" || !/^[a-z]{55}$/.test(seed)) {
    throw new Error("QPAY_MCP_SEED must be a Qubic seed: 55 lowercase letters a-z.");
  }
  const direct = seedPayer({ seed, rpcUrl });
  const contract = contractPayer({ seed, rpcUrl });
  return {
    name: "wallet",
    pay: (req) => (req.settlement === "contract" ? contract.pay(req) : direct.pay(req)),
    signVoucher: (message) => direct.signVoucher(message),
    address: () => direct.address(),
  };
}

module.exports = { walletPayer };
