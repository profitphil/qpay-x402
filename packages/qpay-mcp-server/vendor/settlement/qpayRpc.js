// settlement/qpayRpc.js
//
// The one place that actually talks to a deployed QPAY contract over the
// public RPC (querySmartContract) - shared by contractReceipt.js (the
// paywall's v2 settlement backend) and invoice.js's opt-in contract
// confirmation path, so there's exactly one implementation of "how do we
// read from QPAY" rather than two that could drift apart.
//
// QPAY_CONTRACT_INDEX defaults to 29, the index QPAY was granted on
// mainnet (live since 2026-09-16). It used to default to 31 - the index
// wired into a local qubic/core checkout - which was right while nothing
// was deployed and became a hazard the moment something was: a deployment
// that forgot the variable would derive a contract address no contract
// lives at, and send real payments there. Now the default is the real
// thing and the LOCAL case is what needs the override, which puts the cost
// of forgetting on a dev machine instead of on mainnet.
//
// Every failure path here throws; callers decide how to fail closed.

const RPC_URL = (process.env.QUBIC_RPC_URL || "https://rpc.qubic.org").replace(/\/$/, "");
const RPC_TIMEOUT_MS = Number(process.env.QUBIC_RPC_TIMEOUT_MS || 15000);
const CONTRACT_INDEX = Number(process.env.QPAY_CONTRACT_INDEX || 29);

// Registered function ids - stable ABI, must match Qpay.h's REGISTER block.
const FUNC_GET_RECEIPT = 1;
const FUNC_COMPUTE_RECEIPT_KEY = 2;
const FUNC_GET_INFO = 3;

async function querySmartContract(inputType, requestBuf) {
  const res = await fetch(`${RPC_URL}/v1/querySmartContract`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      contractIndex: CONTRACT_INDEX,
      inputType,
      inputSize: requestBuf.length,
      requestData: requestBuf.toString("base64"),
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const e = new Error(`querySmartContract HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const body = await res.json();
  if (!body || typeof body.responseData !== "string") {
    throw new Error("querySmartContract: malformed response");
  }
  return Buffer.from(body.responseData, "base64");
}

async function getCurrentTick() {
  const res = await fetch(`${RPC_URL}/v1/tick-info`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tick-info HTTP ${res.status}`);
  const body = await res.json();
  const tick = body && body.tickInfo && body.tickInfo.tick;
  if (typeof tick !== "number") throw new Error("tick-info: malformed response");
  return tick;
}

// The network's current tick AND epoch - the public stats page files each
// contract snapshot under the epoch the chain itself reports, rather than
// working it out from the clock.
async function getTickInfo() {
  const res = await fetch(`${RPC_URL}/v1/tick-info`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tick-info HTTP ${res.status}`);
  const body = await res.json();
  const info = body && body.tickInfo;
  if (!info || typeof info.tick !== "number" || typeof info.epoch !== "number") {
    throw new Error("tick-info: malformed response");
  }
  return { tick: info.tick, epoch: info.epoch };
}

// The QPAY contract's own 60-char identity, derived from its index the same
// way every Qubic contract address is: id(index, 0, 0, 0). Needed as the
// `to` address a buyer's wallet sends to when invoking Pay - contract
// identities need the real K12 checksum to render correctly (unlike
// qubicStructs.js's identityToBytes, which deliberately skips it since it
// only ever needs to decode for byte comparison, never re-encode). Reuses
// @qubic-lib/qubic-ts-library's QubicHelper, the same official library
// server.js already uses for a different operation (turning signed-
// transaction bytes into a tx id via getHumanReadableBytes, which that
// library hardcodes to lowercase - correct for a tx id, but NOT the
// canonical form for an address/identity, which is uppercase everywhere
// else in this codebase, including identityToBytes's own regex). Uses
// getIdentity(bytes, false) directly instead - same underlying K12 +
// base-26 encoding, just without the lowercase flag.
let cachedContractIdentity = null;
async function contractIdentity() {
  if (cachedContractIdentity) return cachedContractIdentity;
  const { QubicHelper } = require("@qubic-lib/qubic-ts-library/dist/qubicHelper");
  const bytes = Buffer.alloc(32);
  bytes.writeBigUInt64LE(BigInt(CONTRACT_INDEX), 0);
  cachedContractIdentity = await new QubicHelper().getIdentity(bytes, false);
  return cachedContractIdentity;
}

module.exports = {
  CONTRACT_INDEX,
  FUNC_GET_RECEIPT,
  FUNC_COMPUTE_RECEIPT_KEY,
  FUNC_GET_INFO,
  querySmartContract,
  getCurrentTick,
  getTickInfo,
  contractIdentity,
};
