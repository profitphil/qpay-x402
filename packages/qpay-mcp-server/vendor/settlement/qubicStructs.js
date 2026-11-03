// settlement/qubicStructs.js
//
// Binary codec for QPAY contract I/O structs and Qubic identities.
//
// Struct layouts are NOT guessed: every offset below was extracted from
// clang -fdump-record-layouts over the real Qpay.h compiled against
// qubic/core headers (x86_64 target, the layout consensus runs on):
//
//   Pay_input              72 B  { seller@0, resourceId@32, nonce@64 }
//   GetReceipt_input       32 B  { receiptKey@0 }
//   GetReceipt_output     144 B  { returnCode@0, payer@8, seller@40,
//                                  resourceId@72, nonce@104, amountPaid@112,
//                                  fee@120, epochPaid@128, tickPaid@132,
//                                  consumed@136 }
//   ComputeReceiptKey_input 104 B { payer@0, seller@32, resourceId@64, nonce@96 }
//   GetInfo_output        152 B  { feeBp@0, minPayment@8,
//                                  retentionEpochs@16, padding@20,
//                                  receiptCount@24, feePool@32,
//                                  totalPayments@40, totalVolume@48,
//                                  totalFeesCollected@56,
//                                  totalFeesDistributed@64,
//                                  totalConsumed@72, totalPurged@80,
//                                  feeFloorQu@88, shareholderPermille@96,
//                                  totalShareholderDividends@104,
//                                  totalTokenholderDividends@112,
//                                  affiliateCommissionPermille@120,
//                                  affiliateTermEpochs@128, padding1@132,
//                                  burnPermille@136, totalBurned@144 }
//
//   The deployed mainnet contract is QPAYHUB, index 29, whose source is
//   qubic/core src/contracts/QPayhub.h - NOT this repo's contract/Qpay.h,
//   which stops at @120. The affiliate and burn fields were appended there
//   and confirmed against a live 152-byte reply on 2026-09-18.
//
//   GetInfo_output GROWS BY APPENDING ONLY - never insert a field next to
//   the one it logically belongs with. It was 88 B, then 96 B (feeFloorQu),
//   then 120 B (dividends), now 152 B (affiliate, burn); every earlier
//   offset survived each time because new fields went on the end.
//   decodeGetInfoOutput() length-guards each late field, so an older
//   deployed contract's shorter reply still decodes. Inserting instead of
//   appending silently shifts every offset after it and this decoder reads
//   garbage. Next free offset: @152.
//
// All integers little-endian, ids are 32 raw bytes, no over-alignment.

const crypto = require("crypto");

// ---------------------------------------------------------------------
// Qubic identity codec
//
// A 60-char identity is 56 data chars + 4 checksum chars. The data chars
// encode four uint64 words, each as 14 base-26 chars (A..Z), least
// significant digit first. Contract identities follow directly:
// id(1,0,0,0) -> first word 1 -> "B" + 13x"A" ... (the QX address).
//
// The 4 checksum chars require KangarooTwelve, which is deliberately not
// reimplemented here - decoding for byte comparison does not need it, so
// identityToBytes ignores the checksum. Comparisons against on-chain ids
// are done in byte space.
// ---------------------------------------------------------------------

const A = "A".charCodeAt(0);

const MAX_U64 = (1n << 64n) - 1n;

function identityToBytes(identity) {
  if (typeof identity !== "string" || !/^[A-Z]{60}$/.test(identity)) {
    return null;
  }
  const buf = Buffer.alloc(32);
  for (let word = 0; word < 4; word++) {
    let value = 0n;
    // 14 chars per word, most significant char last => walk backwards
    for (let idx = 13; idx >= 0; idx--) {
      const c = BigInt(identity.charCodeAt(word * 14 + idx) - A);
      if (c > 25n) return null;
      value = value * 26n + c;
    }
    // A real identity's base-26 digits always decode back within 64 bits
    // (that's the whole point of the encoding) - this only trips on
    // malformed/non-identity input. Buffer.writeBigUInt64LE throws on an
    // out-of-range value rather than wrapping it, which would otherwise
    // surface as an uncaught exception here instead of this function's
    // normal "not a valid identity" contract (return null) - reject
    // explicitly so a bad string fails closed the same way every other
    // malformed-input case here already does.
    if (value > MAX_U64) return null;
    buf.writeBigUInt64LE(value, word * 8);
  }
  return buf;
}

// Data chars only (56); the checksum requires K12 so callers that need a
// full identity must go through the chain. Used for diagnostics.
function bytesToIdentityStem(buf) {
  let out = "";
  for (let word = 0; word < 4; word++) {
    let value = buf.readBigUInt64LE(word * 8);
    for (let i = 0; i < 14; i++) {
      out += String.fromCharCode(Number(value % 26n) + A);
      value = value / 26n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Resource tags
//
// On-chain resourceId is an opaque 32-byte value. The off-chain
// convention: tag = SHA-256 of the resourceId string. The buyer SDK and
// the facilitator must use the same convention or attribution fails
// closed (tag mismatch), never open.
// ---------------------------------------------------------------------

function resourceTag(resourceIdString) {
  return crypto.createHash("sha256").update(String(resourceIdString), "utf8").digest();
}

// Accepts a 32-byte reference as 64-char hex or base64.
function referenceToBytes(reference) {
  if (typeof reference !== "string") return null;
  if (/^[0-9a-fA-F]{64}$/.test(reference)) {
    return Buffer.from(reference, "hex");
  }
  try {
    const b = Buffer.from(reference, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Struct encode / decode
// ---------------------------------------------------------------------

function encodeGetReceiptInput(receiptKeyBytes) {
  return Buffer.from(receiptKeyBytes); // exactly the 32-byte key
}

/**
 * Encodes the payload a buyer's wallet must sign when invoking QPAY.Pay -
 * NOT used to talk to querySmartContract (that's read-only); this is the
 * `payload` bytes of an actual on-chain transaction, matching Pay_input's
 * real compiled layout exactly (verified via clang -fdump-record-layouts,
 * same as every other struct in this file - see the header comment).
 */
function encodePayInput({ seller, resourceId, nonce }) {
  const buf = Buffer.alloc(72);
  seller.copy(buf, 0);
  resourceId.copy(buf, 32);
  buf.writeBigUInt64LE(BigInt(nonce), 64);
  return buf;
}

function decodeGetReceiptOutput(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 144) return null;
  return {
    returnCode: buf.readBigUInt64LE(0),
    payer: buf.subarray(8, 40),
    seller: buf.subarray(40, 72),
    resourceId: buf.subarray(72, 104),
    nonce: buf.readBigUInt64LE(104),
    amountPaid: buf.readBigInt64LE(112),
    fee: buf.readBigInt64LE(120),
    epochPaid: buf.readUInt32LE(128),
    tickPaid: buf.readUInt32LE(132),
    consumed: buf.readUInt8(136) !== 0,
  };
}

function encodeComputeReceiptKeyInput({ payer, seller, resourceId, nonce }) {
  const buf = Buffer.alloc(104);
  payer.copy(buf, 0);
  seller.copy(buf, 32);
  resourceId.copy(buf, 64);
  buf.writeBigUInt64LE(BigInt(nonce), 96);
  return buf;
}

// ComputeReceiptKey_output is just the 32-byte id itself (no returnCode -
// the function is pure, it can't fail), unlike every other _output struct
// in this file which leads with a returnCode.
function decodeComputeReceiptKeyOutput(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null;
  return buf.subarray(0, 32);
}

function decodeGetInfoOutput(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 88) return null;
  return {
    feeBp: buf.readBigUInt64LE(0),
    minPayment: buf.readBigInt64LE(8),
    retentionEpochs: buf.readUInt32LE(16),
    receiptCount: buf.readBigUInt64LE(24),
    feePool: buf.readBigInt64LE(32),
    totalPayments: buf.readBigUInt64LE(40),
    totalVolume: buf.readBigUInt64LE(48),
    totalFeesCollected: buf.readBigUInt64LE(56),
    totalFeesDistributed: buf.readBigUInt64LE(64),
    totalConsumed: buf.readBigUInt64LE(72),
    totalPurged: buf.readBigUInt64LE(80),
    // Added by the fee floor change - null against an old (pre-floor)
    // deployed contract's 88-byte reply rather than throwing, so this
    // decoder keeps working against either contract version.
    feeFloorQu: buf.length >= 96 ? buf.readBigInt64LE(88) : null,
    // Dividend accounting, then the affiliate and burn additions - each
    // null against a contract too old to report it.
    shareholderPermille: buf.length >= 104 ? buf.readBigUInt64LE(96) : null,
    totalShareholderDividends: buf.length >= 112 ? buf.readBigUInt64LE(104) : null,
    totalTokenholderDividends: buf.length >= 120 ? buf.readBigUInt64LE(112) : null,
    affiliateCommissionPermille: buf.length >= 128 ? buf.readBigUInt64LE(120) : null,
    affiliateTermEpochs: buf.length >= 132 ? buf.readUInt32LE(128) : null,
    burnPermille: buf.length >= 144 ? buf.readBigUInt64LE(136) : null,
    totalBurned: buf.length >= 152 ? buf.readBigUInt64LE(144) : null,
  };
}

// Test-only helper: build a GetReceipt_output image so decode can be
// verified against the dumped layout without a deployed contract.
function encodeGetReceiptOutputForTest(r) {
  const buf = Buffer.alloc(144);
  buf.writeBigUInt64LE(BigInt(r.returnCode), 0);
  r.payer.copy(buf, 8);
  r.seller.copy(buf, 40);
  r.resourceId.copy(buf, 72);
  buf.writeBigUInt64LE(BigInt(r.nonce), 104);
  buf.writeBigInt64LE(BigInt(r.amountPaid), 112);
  buf.writeBigInt64LE(BigInt(r.fee), 120);
  buf.writeUInt32LE(r.epochPaid, 128);
  buf.writeUInt32LE(r.tickPaid, 132);
  buf.writeUInt8(r.consumed ? 1 : 0, 136);
  return buf;
}

module.exports = {
  identityToBytes,
  bytesToIdentityStem,
  resourceTag,
  referenceToBytes,
  encodeGetReceiptInput,
  decodeGetReceiptOutput,
  encodePayInput,
  encodeComputeReceiptKeyInput,
  decodeComputeReceiptKeyOutput,
  decodeGetInfoOutput,
  encodeGetReceiptOutputForTest,
};
