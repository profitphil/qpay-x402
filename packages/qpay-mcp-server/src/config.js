// config.js - settings from the environment the MCP host starts us with.

const os = require("os");
const path = require("path");

function positiveInt(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(String(raw).replace(/[_,]/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a whole number of QU above 0, got "${raw}"`);
  return n;
}

function network(raw) {
  const n = raw || "qubic:mainnet";
  if (n !== "qubic:mainnet" && n !== "qubic:sandbox") throw new Error(`QPAY_MCP_NETWORK must be qubic:mainnet or qubic:sandbox, got "${raw}"`);
  return n;
}

function fromEnv(env = process.env) {
  const dataDir = env.QPAY_MCP_DATA_DIR || path.join(os.homedir(), ".qpay-mcp");
  return {
    seed: env.QPAY_MCP_SEED ? env.QPAY_MCP_SEED.trim() : null,
    rpcUrl: (env.QUBIC_RPC_URL || "https://rpc.qubic.org").replace(/\/$/, ""),
    // qubic:sandbox (with QUBIC_RPC_URL=https://sandbox.useqpay.com/rpc) for
    // the sandbox's test network; anything else is refused at start.
    network: network(env.QPAY_MCP_NETWORK),
    ledgerPath: path.join(dataDir, "payments.jsonl"),
    limits: {
      maxPerCall: positiveInt(env, "QPAY_MAX_PER_CALL", 10000),
      maxDeposit: positiveInt(env, "QPAY_MAX_DEPOSIT", 50000),
      maxPerDay: positiveInt(env, "QPAY_MAX_PER_DAY", 100000),
      allowedHosts: (env.QPAY_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    },
  };
}

module.exports = { fromEnv };
