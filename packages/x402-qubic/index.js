// x402-qubic: the Qubic payment scheme for the official x402 v2 client.
//
//   const { x402Client } = require("@x402/core/client");
//   const { wrapFetchWithPayment } = require("@x402/fetch");
//   const { ExactQubicScheme, seedSigner, QUBIC_MAINNET } = require("x402-qubic");
//
//   const client = new x402Client()
//     .register(QUBIC_MAINNET, new ExactQubicScheme({ signer: seedSigner(process.env.QUBIC_SEED) }))
//     .setSpendControls({ allowedAssets: [{ network: QUBIC_MAINNET, asset: "QUBIC", maxAmountPerPayment: "10000" }] });
//   const fetchWithPay = wrapFetchWithPayment(fetch, client);
//
// Seller side, with the official @x402/express:
//
//   const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://useqpay.com/facilitator" }))
//     .register(QUBIC_MAINNET, new ExactQubicServerScheme({ ticketKey: process.env.QPAY_TICKET_KEY }));
//   app.use(paymentMiddleware({ "GET /feed": { accepts: { scheme: "exact", network: QUBIC_MAINNET,
//     price: "20000 QU", payTo: process.env.QUBIC_ADDRESS, extra: { resourceId: "/feed" } } } }, server));

const { ExactQubicScheme, QUBIC_MAINNET, QUBIC_SANDBOX, QPAY_CONTRACT_ADDRESS } = require("./src/scheme");
const { seedSigner } = require("./src/signer");
const { ExactQubicServerScheme } = require("./src/server");
const { createChannelFetch, ChannelError } = require("./src/channel");

module.exports = {
  ExactQubicScheme,
  ExactQubicServerScheme,
  seedSigner,
  createChannelFetch,
  ChannelError,
  QUBIC_MAINNET,
  QUBIC_SANDBOX,
  QPAY_CONTRACT_ADDRESS,
};
