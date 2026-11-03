// qpay-mcp-server: an MCP server that lets AI assistants pay x402 endpoints
// in Qubic (QU). See README.md. The CLI entry is bin/qpay-mcp-server.js.

const { createQpayMcp, readTerms } = require("./src/server");
const { createSpending, SpendRefused } = require("./src/spending");
const { walletPayer } = require("./src/payer");
const { fromEnv } = require("./src/config");

module.exports = { createQpayMcp, createSpending, SpendRefused, walletPayer, fromEnv, readTerms };
