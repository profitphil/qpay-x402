// Payment tickets.
//
// A Qubic transaction hash is public the instant it is on-chain. Anyone
// watching the chain can see that somebody paid you, take that hash, and
// try to claim the content before the real payer does.
//
// The ticket closes that. When you answer with a 402 you mint a random
// nonce, BEFORE any payment exists, and hand it only to that one caller.
// They must put that exact nonce into the payment itself. The facilitator
// checks the on-chain nonce matches the ticket. Someone watching the chain
// sees the payment but never saw the nonce, so they cannot claim it.
//
// The claims are signed, not secret - they travel base64url like a JWT.
// Nothing in them is sensitive; the security comes from the nonce being
// unpredictable and privately delivered.

const crypto = require("crypto");

const VERSION = "pt1";
const NONCE_BYTES = 8; // the contract reads this as a uint64 - exactly 8

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Mint a ticket for one purchase.
 *
 * @param {string} key        your ticket signing key (Q+Pay dashboard)
 * @param {string} sellerId   your Qubic address - who the money is FOR
 * @param {string} resourceId stable id for the thing being sold. Must be
 *                            byte-identical when you verify, so avoid
 *                            anything that varies per request.
 * @param {string|number} amount  price in QU
 * @param {number} seconds    ticket life; 600 is sane
 * @returns {{token: string, nonceHex: string, expiresAt: number}}
 */
function issueTicket(key, { sellerId, resourceId, amount, seconds = 600 }) {
  if (!key) throw new Error("issueTicket needs your ticket signing key");
  const now = Math.floor(Date.now() / 1000);
  const nonceHex = crypto.randomBytes(NONCE_BYTES).toString("hex");
  const claims = {
    v: VERSION,
    sellerId: sellerId || null,
    resourceId: resourceId || null,
    amount: String(amount),
    nonce: nonceHex,
    iat: now,
    exp: now + Math.max(1, Math.floor(seconds)),
  };
  const payload = b64u(JSON.stringify(claims));
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, nonceHex, expiresAt: claims.exp };
}

/**
 * Check a ticket you issued. You do not have to call this - the facilitator
 * checks it too, with the same key - but it is useful for failing fast
 * before a network round trip.
 */
function verifyTicket(key, token, { sellerId, resourceId, amount }) {
  if (typeof token !== "string" || !token) return { valid: false, reason: "ticket_missing" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { valid: false, reason: "ticket_malformed" };

  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac("sha256", key).update(payload).digest("base64url"));
  // Length-checked first: timingSafeEqual throws on a length mismatch.
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { valid: false, reason: "ticket_bad_signature" };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "ticket_malformed" };
  }
  if (!claims || claims.v !== VERSION) return { valid: false, reason: "ticket_version" };
  if (typeof claims.exp !== "number" || Math.floor(Date.now() / 1000) >= claims.exp) {
    return { valid: false, reason: "ticket_expired" };
  }
  if (claims.sellerId !== (sellerId || null)) return { valid: false, reason: "ticket_wrong_seller" };
  if (claims.resourceId !== (resourceId || null)) return { valid: false, reason: "ticket_wrong_resource" };
  if (claims.amount !== String(amount)) return { valid: false, reason: "ticket_wrong_amount" };
  if (!/^[0-9a-f]{16}$/.test(claims.nonce || "")) return { valid: false, reason: "ticket_malformed" };
  return { valid: true, claims };
}

/** A ticket's nonce without verifying it - for a BUYER reading its own. */
function readNonce(token) {
  try {
    const payload = String(token).slice(0, String(token).lastIndexOf("."));
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).nonce || null;
  } catch {
    return null;
  }
}

module.exports = { issueTicket, verifyTicket, readNonce, VERSION };
