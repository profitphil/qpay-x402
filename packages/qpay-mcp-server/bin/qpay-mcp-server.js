#!/usr/bin/env node
// Started by an MCP host (Claude Desktop, Claude Code, Cursor, ...) over stdio.
// stdout carries the protocol: everything human-readable goes to stderr.

const { serveStdio } = require("@modelcontextprotocol/server/stdio");
const { createQpayMcp, createSpending, walletPayer, fromEnv } = require("..");

let cfg;
try {
  cfg = fromEnv();
} catch (err) {
  console.error(`qpay-mcp-server: ${err.message}`);
  process.exit(1);
}
let payer = null;
if (cfg.seed) {
  try {
    payer = walletPayer({ seed: cfg.seed, rpcUrl: cfg.rpcUrl });
  } catch (err) {
    console.error(`qpay-mcp-server: ${err.message}`);
    process.exit(1);
  }
}
const spending = createSpending({ limits: cfg.limits, ledgerPath: cfg.ledgerPath, network: cfg.network });
const { createServer } = createQpayMcp({ payer, spending, rpcUrl: cfg.rpcUrl, network: cfg.network });
serveStdio(createServer);
console.error(
  `qpay-mcp-server running on stdio (${cfg.network}) - ${payer ? "wallet configured" : "no wallet (QPAY_MCP_SEED not set): prices can be checked, nothing can be paid"}; ` +
    `limits ${cfg.limits.maxPerCall} QU/request, ${cfg.limits.maxDeposit} QU/deposit, ${cfg.limits.maxPerDay} QU/24h; ledger ${cfg.ledgerPath}`
);
