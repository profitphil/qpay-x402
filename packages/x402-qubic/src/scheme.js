// scheme.js - ExactQubicScheme, an x402 v2 SchemeNetworkClient for qubic:mainnet
// (or, with `network`, the qubic:sandbox test network of sandbox.useqpay.com).
//
// The official x402 client hands a scheme the one payment option it chose
// (accepts[i]) and asks for a payload to send back. On EVM that payload is a
// signed authorization the facilitator later executes. On Qubic there is no
// such thing: the buyer makes the payment itself, as a Qubic transaction, and
// the proof is the transaction id plus the seller's one-time payment ticket
// (whose nonce the transaction carries, so nobody watching the chain can
// claim the payment first). So createPaymentPayload here really pays, waits
// until the network has executed the transaction, and returns
// { txHash, ticket }.
//
// Because it moves money, it refuses before anything is signed when:
//   - the option is not exact / this scheme's network / QUBIC, or the amount is not
//     a whole number of QU;
//   - the amount is over the cap the client's spend controls resolved;
//   - there is no ticket, or the ticket's claims disagree with the option
//     (seller, resource, amount) or it has expired;
//   - settlement is "contract" and payTo is not the QPAY contract - QU sent
//     anywhere else with a Pay input would be lost;
//   - the seller id is not a Qubic identity.

const crypto = require("crypto");

const QUBIC_MAINNET = "qubic:mainnet";
// The emulated network of sandbox.useqpay.com: no real QU. Use it with that
// sandbox's RPC, rpcUrl "https://sandbox.useqpay.com/rpc".
const QUBIC_SANDBOX = "qubic:sandbox";
// Each network's Qubic RPC. A sandbox scheme left on the mainnet RPC would
// read mainnet's tick, and a signer on mainnet could then pay real QU to a
// sandbox seller's address.
const RPC_URLS = { [QUBIC_MAINNET]: "https://rpc.qubic.org", [QUBIC_SANDBOX]: "https://sandbox.useqpay.com/rpc" };
// QPAY (QPAYHUB), Qubic contract index 29.
const QPAY_CONTRACT_ADDRESS = "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH";
const PROC_PAY = 1;
// Time allowed after confirmation for the client to send proof and the seller
// to settle it; a ticket must outlive confirmTimeoutMs plus this.
const TICKET_SETTLE_MARGIN_MS = 30_000;
const A = "A".charCodeAt(0);
const MAX_U64 = (1n << 64n) - 1n;

class QubicPaymentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "QubicPaymentError";
    this.code = code;
  }
}

/** A Qubic identity's 32 public-key bytes, or null if it is not one. */
function identityToBytes(identity) {
  if (typeof identity !== "string" || !/^[A-Z]{60}$/.test(identity)) return null;
  const buf = Buffer.alloc(32);
  for (let word = 0; word < 4; word++) {
    let value = 0n;
    for (let idx = 13; idx >= 0; idx--) value = value * 26n + BigInt(identity.charCodeAt(word * 14 + idx) - A);
    if (value > MAX_U64) return null;
    buf.writeBigUInt64LE(value, word * 8);
  }
  return buf;
}

function ticketClaims(ticket) {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return null;
  try {
    return JSON.parse(Buffer.from(ticket.slice(0, dot), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ExactQubicScheme {
  /**
   * @param {object} opts
   * @param {object} opts.signer           { address(): Promise<string>, send({ to, amount, inputType, input, tick }): Promise<txId> } - see seedSigner()
   * @param {string} [opts.rpcUrl]         Qubic RPC, for the current tick and confirmation (default: the network's)
   * @param {string} [opts.network]        qubic:mainnet (default) or qubic:sandbox; options on any other network are refused
   * @param {number} [opts.tickOffset]     how far ahead to target (ticks are ~0.5 s apart)
   * @param {number} [opts.confirmTimeoutMs] how long to wait for the network to execute the payment
   * @param {number} [opts.pollMs]
   * @param {string[]} [opts.contractAddresses] addresses accepted as payTo under contract settlement
   * @param {Function} [opts.fetch]
   */
  constructor({ signer, rpcUrl, network = QUBIC_MAINNET, tickOffset = 30, confirmTimeoutMs = 90_000, pollMs = 2000, contractAddresses = [QPAY_CONTRACT_ADDRESS], fetch: fetchImpl } = {}) {
    if (!signer || typeof signer.send !== "function") throw new Error("ExactQubicScheme needs a signer (see seedSigner)");
    if (network !== QUBIC_MAINNET && network !== QUBIC_SANDBOX) throw new Error(`ExactQubicScheme network must be ${QUBIC_MAINNET} or ${QUBIC_SANDBOX}`);
    this.scheme = "exact";
    this.network = network;
    this.signer = signer;
    this.rpcUrl = (rpcUrl || RPC_URLS[network]).replace(/\/$/, "");
    if (network === QUBIC_SANDBOX && this.rpcUrl === RPC_URLS[QUBIC_MAINNET]) {
      throw new Error("A qubic:sandbox scheme cannot use the mainnet RPC; leave rpcUrl out or use https://sandbox.useqpay.com/rpc");
    }
    this.tickOffset = tickOffset;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.pollMs = pollMs;
    this.contractAddresses = new Set(contractAddresses);
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async rpc(path) {
    const r = await this.fetch(`${this.rpcUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    return r;
  }

  async currentTick() {
    const r = await this.rpc("/v1/tick-info");
    if (!r.ok) throw new QubicPaymentError(`Qubic RPC tick-info: HTTP ${r.status}`, "rpc_unavailable");
    const tick = ((await r.json()).tickInfo || {}).tick;
    if (typeof tick !== "number") throw new QubicPaymentError("Qubic RPC returned no tick", "rpc_unavailable");
    return tick;
  }

  /** The last tick the RPC's indexer has processed, or null if it does not say. */
  async indexedTick() {
    const r = await this.rpc("/v1/status");
    if (!r.ok) return null;
    const t = ((await r.json()).lastProcessedTick || {}).tickNumber;
    return typeof t === "number" ? t : null;
  }

  async isIndexed(txId) {
    const r = await this.rpc(`/v2/transactions/${txId}`).catch(() => null);
    return Boolean(r && r.ok);
  }

  /** Resolves once the network has executed txId; throws if its tick passed without it. */
  async waitForExecution(txId, targetTick) {
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isIndexed(txId)) {
        // An unavailable status endpoint counts as moved: /settle reads
        // moneyFlew itself and refuses a payment that moved nothing, so this
        // only decides whether to stop the buyer early, never what is paid.
        const status = await this.rpc(`/v1/tx-status/${txId}`).catch(() => null);
        const moneyFlew = status && status.ok ? ((await status.json()).transactionStatus || {}).moneyFlew : true;
        if (moneyFlew === false) throw new QubicPaymentError(`Transaction ${txId} executed but moved no QU (insufficient balance?)`, "payment_not_executed");
        return;
      }
      // Dropped only once the INDEXER is past its tick. tick-info runs ahead
      // of the indexer (often 15-20 ticks), so judging by it reported
      // payments that did execute as dropped, inviting a second payment.
      // Looked up again after the indexer check, in case it was indexed
      // between the two reads. An indexer that does not report its progress
      // never makes a payment "dropped"; it runs into confirm_timeout instead.
      const indexed = await this.indexedTick().catch(() => null);
      if (indexed != null && indexed > targetTick + 5 && !(await this.isIndexed(txId))) {
        throw new QubicPaymentError(`Transaction ${txId} was not included by tick ${targetTick}; nothing was paid. Try again.`, "payment_dropped");
      }
      await sleep(this.pollMs);
    }
    throw new QubicPaymentError(`Transaction ${txId} not confirmed within ${Math.round(this.confirmTimeoutMs / 1000)} s. It may still land; check it before paying again.`, "confirm_timeout");
  }

  /**
   * Called by x402Client with the option it selected.
   * @returns {Promise<{x402Version: number, payload: {txHash: string, ticket: string}}>}
   */
  async createPaymentPayload(x402Version, requirements, context = {}) {
    const extra = requirements.extra || {};
    if (requirements.scheme !== "exact" || requirements.network !== this.network) {
      throw new QubicPaymentError(`Not a Qubic exact payment (${requirements.scheme} on ${requirements.network})`, "unsupported_requirements");
    }
    if (requirements.asset !== "QUBIC") throw new QubicPaymentError(`Unsupported asset ${requirements.asset}; only QUBIC (QU)`, "unsupported_asset");
    if (!/^[0-9]+$/.test(String(requirements.amount)) || BigInt(requirements.amount) <= 0n) {
      throw new QubicPaymentError(`Amount must be a whole number of QU, got ${requirements.amount}`, "invalid_amount");
    }
    const amount = BigInt(requirements.amount);
    if (context.maxAmountPerPayment != null && amount > BigInt(context.maxAmountPerPayment)) {
      throw new QubicPaymentError(`Price ${amount} QU is over the spend cap of ${context.maxAmountPerPayment} QU; nothing was paid`, "spend_cap");
    }

    const ticket = extra.paymentTicket;
    const claims = ticketClaims(ticket);
    if (!claims) throw new QubicPaymentError("No payment ticket in accepts[].extra.paymentTicket; the seller must issue one", "ticket_missing");
    const sellerId = extra.sellerId || requirements.payTo;
    if (claims.sellerId !== sellerId || (extra.resourceId != null && claims.resourceId !== extra.resourceId) || String(claims.amount) !== String(requirements.amount)) {
      throw new QubicPaymentError("The payment ticket does not match this payment option (seller, resource or amount); nothing was paid", "ticket_mismatch");
    }
    // The ticket must outlive confirming the payment and settling it: one
    // that expires in between is paid for and then refused at /settle.
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now() + this.confirmTimeoutMs + TICKET_SETTLE_MARGIN_MS) {
      throw new QubicPaymentError("The payment ticket has expired or would expire before the payment settles; request the resource again", "ticket_expired");
    }
    if (typeof claims.nonce !== "string" || !/^[0-9a-f]{16}$/.test(claims.nonce)) throw new QubicPaymentError("The payment ticket has no valid nonce", "ticket_invalid");
    const nonceBytes = Buffer.from(claims.nonce, "hex");

    const settlement = extra.settlement || "direct";
    let tx;
    if (settlement === "contract") {
      // The receipt is tagged with SHA-256(resourceId); without one it would
      // name no resource and the seller would refuse a payment already made.
      if (typeof extra.resourceId !== "string" || !extra.resourceId) {
        throw new QubicPaymentError("Contract settlement without accepts[].extra.resourceId cannot be matched to what is sold; nothing was paid", "resource_missing");
      }
      if (!this.contractAddresses.has(requirements.payTo)) {
        throw new QubicPaymentError(`Contract settlement to ${requirements.payTo}, which is not the QPAY contract; refusing so no QU is lost`, "unknown_contract");
      }
      const seller = identityToBytes(sellerId);
      if (!seller) throw new QubicPaymentError(`Seller id ${sellerId} is not a Qubic identity`, "invalid_seller");
      const tag = crypto.createHash("sha256").update(extra.resourceId, "utf8").digest();
      tx = { to: requirements.payTo, amount, inputType: PROC_PAY, input: Buffer.concat([seller, tag, nonceBytes]) };
    } else if (settlement === "direct") {
      if (!identityToBytes(requirements.payTo)) throw new QubicPaymentError(`payTo ${requirements.payTo} is not a Qubic identity`, "invalid_pay_to");
      tx = { to: requirements.payTo, amount, inputType: 0, input: nonceBytes };
    } else {
      throw new QubicPaymentError(`Unknown settlement "${settlement}"`, "unsupported_settlement");
    }

    const tick = (await this.currentTick()) + this.tickOffset;
    const txHash = await this.signer.send({ ...tx, tick });
    await this.waitForExecution(txHash, tick);
    return { x402Version, payload: { txHash, ticket } };
  }
}

module.exports = { ExactQubicScheme, QubicPaymentError, QUBIC_MAINNET, QUBIC_SANDBOX, QPAY_CONTRACT_ADDRESS, identityToBytes, ticketClaims };
