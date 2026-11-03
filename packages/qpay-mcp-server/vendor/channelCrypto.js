// channelCrypto.js
//
// Low-level signing/verification for payment-channel vouchers, isolated
// from channel business logic so the rest of the codebase never has to
// know about WASM buffer quirks.
//
// Verified empirically against the real @qubic-lib/qubic-ts-library (see
// commit history for the exploration): the canonical public key is 32
// bytes (crypto.PUBLIC_KEY_LENGTH). KeyHelper.createPublicKey() returns a
// 35-byte buffer whose first 32 bytes exactly match the 32-byte form
// QubicHelper.getIdentityBytes() derives from an address string - the
// extra 3 bytes are a WASM binding artifact, not part of the key. This
// module always uses the clean 32-byte form so signing (which has a seed)
// and verifying (which only ever has an address string) use one
// consistent representation instead of two, which is a bug magnet.
//
// schnorrq.sign(privateKey, publicKey, digest) -> 64-byte signature
// schnorrq.verify(publicKey, digest, signature) -> 1/0 (not strict bool)

let libs = null;
async function load() {
  if (libs) return libs;
  const { default: cryptoPromise } = require("@qubic-lib/qubic-ts-library/dist/crypto");
  const { KeyHelper } = require("@qubic-lib/qubic-ts-library/dist/keyHelper");
  const { QubicHelper } = require("@qubic-lib/qubic-ts-library/dist/qubicHelper");
  const { schnorrq, K12 } = await cryptoPromise;
  libs = { schnorrq, K12, keyHelper: new KeyHelper(), helper: new QubicHelper() };
  return libs;
}

function digestOf(K12, message) {
  const digest = new Uint8Array(32);
  K12(Buffer.isBuffer(message) ? message : Buffer.from(String(message), "utf8"), digest, 32);
  return digest;
}

/**
 * Derive signing keys from a seed. Used by the buyer (payers.js) - the
 * facilitator never sees a seed, only addresses and signatures.
 */
async function deriveKeys(seed) {
  const { keyHelper, schnorrq, K12, helper } = await load();
  const privateKey = keyHelper.privateKey(seed, 0, K12);
  const idPackage = await helper.createIdPackage(seed);
  const publicKey = helper.getIdentityBytes(idPackage.publicId); // clean 32-byte form
  return { privateKey, publicKey, address: idPackage.publicId };
}

/**
 * Sign a message with a derived private key. Returns a hex signature.
 */
async function signMessage({ privateKey, publicKey }, message) {
  const { schnorrq, K12 } = await load();
  const digest = digestOf(K12, message);
  const signature = schnorrq.sign(privateKey, publicKey, digest);
  return Buffer.from(signature).toString("hex");
}

/**
 * Verify a message was signed by the holder of `address`'s private key.
 * The facilitator's whole trust in a voucher comes from this - it never
 * has the seed, only the claimed address and a signature to check.
 */
async function verifyMessage(address, message, signatureHex) {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    const { schnorrq, K12, helper } = await load();
    const publicKey = helper.getIdentityBytes(address);
    const digest = digestOf(K12, message);
    const signature = Buffer.from(signatureHex, "hex");
    return !!schnorrq.verify(publicKey, digest, signature);
  } catch {
    return false;
  }
}

// Fixed constants the client and server both hard-code for the "ghost tx"
// login-proof scheme below - see verifyTransactionMessage's own comment for
// why this exists. Intended to never be broadcast, so these values aren't
// meant to be economically meaningful; they only need to match between what
// the wallet signed and what this function reconstructs. GHOST_TX_DESTINATION
// is the all-zero public key (32 zero bytes) - real wallets reject a
// transaction whose `from` and `to` are the same address ("Invalid
// argument(s): from and to are the same", confirmed against a real wallet
// app), so the destination has to be something other than the signer - the
// zero key is a real, validly-formed identity nobody can plausibly hold the
// matching private key for.
//
// GHOST_TX_AMOUNT is 1 (not 0) only because a real wallet was never tested
// against amount:0 - the self-transfer rejection above was discovered
// empirically against one real wallet, and amount:0 might hit a similar
// wallet-side quirk that would break login the same way. Since this IS a
// real, validly-signed transaction (see X402-09 in the project's security
// review history), "never broadcast" is a design intent enforced by the
// server, not a cryptographic guarantee - a captured signatureHex+tick
// (server compromise, request logging, pre-TLS-termination MITM) could in
// principle be broadcast for real within its tick's validity window,
// moving 1 QU to the null identity above. dashboardAuth.js bounds `tick`
// against the live current tick to keep that window short regardless (see
// its own comment), which is the mitigation actually shipped; switching
// this to amount:0 would remove even that theoretical exposure, but needs
// live-wallet verification before shipping - don't change it blind.
const GHOST_TX_AMOUNT = 1n;
const GHOST_TX_INPUT_TYPE = 0;
const GHOST_TX_DESTINATION = Buffer.alloc(32);

/**
 * Verify `message` was signed via qubic_signTransaction rather than
 * qubic_sign - the dashboard's WalletConnect login route, used because at
 * least one real wallet app's qubic_sign handler throws an internal error
 * (-32015) after correctly parsing the request, while qubic_signTransaction
 * is already proven correct for real mainnet payments (see checkout.html).
 * The client has the wallet sign an ordinary Qubic transaction from
 * `address` to the fixed null destination above, amount/inputType fixed
 * constants, `message`'s UTF-8 bytes as the payload - then extracts just
 * the trailing 64-byte signature. This function independently rebuilds the
 * exact same envelope Qraffle's own QubicTransaction.build() produces
 * (byte layout confirmed directly against that library's source:
 * sourcePublicKey[32] + destinationPublicKey[32] + amount:int64LE +
 * tick:int32LE + inputType:int16LE + inputSize:int16LE + payload, K12
 * digest over exactly that - NOT the library itself, since it's an
 * async-signing helper built around a seed, not a bytes-in/verify-out
 * function) and verifies the signature against it. The transaction is
 * never broadcast - only its signature bytes are used, as
 * proof-of-key-ownership, never as a real transfer.
 */
async function verifyTransactionMessage(address, message, tick, signatureHex) {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  const tickNum = Number(tick);
  if (!Number.isInteger(tickNum) || tickNum < 0) return false;
  try {
    const { schnorrq, K12, helper } = await load();
    const publicKey = helper.getIdentityBytes(address);
    if (!publicKey) return false;
    const payload = Buffer.from(String(message), "utf8");
    const envelope = Buffer.alloc(32 + 32 + 8 + 4 + 2 + 2 + payload.length);
    let o = 0;
    Buffer.from(publicKey).copy(envelope, o); o += 32; // sourcePublicKey
    GHOST_TX_DESTINATION.copy(envelope, o); o += 32; // destinationPublicKey (fixed null identity)
    envelope.writeBigInt64LE(GHOST_TX_AMOUNT, o); o += 8;
    envelope.writeInt32LE(tickNum, o); o += 4;
    envelope.writeInt16LE(GHOST_TX_INPUT_TYPE, o); o += 2;
    envelope.writeInt16LE(payload.length, o); o += 2;
    payload.copy(envelope, o);

    const digest = new Uint8Array(32);
    K12(envelope, digest, 32);
    const signature = Buffer.from(signatureHex, "hex");
    return !!schnorrq.verify(publicKey, digest, signature);
  } catch {
    return false;
  }
}

module.exports = { deriveKeys, signMessage, verifyMessage, verifyTransactionMessage };
