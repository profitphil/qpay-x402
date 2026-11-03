// server.js - ExactQubicServerScheme, an x402 v2 SchemeNetworkServer for
// qubic:mainnet, so a seller already on the official @x402/express (or any
// x402ResourceServer) can charge in QU through the Q+Pay facilitator (or, with
// `network: QUBIC_SANDBOX`, in test QU through the sandbox's facilitator).
//
// What it adds to the SDK's own flow:
//   - prices: "20000 QU", 20000, { amount, asset: "QUBIC" } (and "$1.50" if
//     you pass a usdToQu converter);
//   - requirements: under contract settlement payTo becomes the QPAY contract
//     and the seller moves to extra.sellerId; extra also states the
//     settlement mode and the resourceId. Both are read from the
//     facilitator's /supported kind, so nothing is hard-coded;
//   - a fresh one-time payment ticket in every 402, in
//     accepts[i].extra.paymentTicket. Its nonce must ride in the buyer's
//     transaction, which is what stops anyone watching the chain from
//     claiming the payment first. It changes on every 402, so it is declared
//     a dynamic field and left out when the SDK matches a payment to a route;
//   - the "upfront" flow: settle before the handler runs. On Qubic the buyer
//     has already paid on-chain; settling is the single-use claim.

const crypto = require("crypto");
const { QUBIC_MAINNET, QUBIC_SANDBOX, QPAY_CONTRACT_ADDRESS, identityToBytes } = require("./scheme");

const DEFAULT_RESOURCE_ID = "x402";

/** The same ticket the qubic-x402-paywall package mints (format pt1). */
function issueTicket(key, { sellerId, resourceId, amount, seconds = 600 }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: "pt1",
    sellerId: sellerId || null,
    resourceId: resourceId || null,
    amount: String(amount),
    nonce: crypto.randomBytes(8).toString("hex"),
    iat: now,
    exp: now + seconds,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}


class ExactQubicServerScheme {
  /**
   * @param {object} opts
   * @param {string} opts.ticketKey       your ticket signing key, from the Q+Pay dashboard. Never send it anywhere.
   * @param {string} [opts.settlement]    force "contract" or "direct"; default: what the facilitator reports
   * @param {Function} [opts.usdToQu]     async (usdNumber) => whole QU as string, to allow "$" prices
   * @param {number} [opts.ticketSeconds] ticket life (default 600)
   * @param {string} [opts.network]       qubic:mainnet (default) or qubic:sandbox
   */
  constructor({ ticketKey, settlement, usdToQu, ticketSeconds = 600, network = QUBIC_MAINNET } = {}) {
    if (!ticketKey || typeof ticketKey !== "string") throw new Error("ExactQubicServerScheme needs your ticketKey from the Q+Pay dashboard");
    if (network !== QUBIC_MAINNET && network !== QUBIC_SANDBOX) throw new Error(`ExactQubicServerScheme network must be ${QUBIC_MAINNET} or ${QUBIC_SANDBOX}`);
    this.scheme = "exact";
    this.network = network;
    this.defaultAssetTransferMethod = "default";
    this.paymentFlows = { default: { supported: ["upfront"], default: "upfront" } };
    this.dynamicExtraFields = ["paymentTicket"];
    this.ticketKey = ticketKey;
    this.settlement = settlement;
    this.usdToQu = usdToQu;
    this.ticketSeconds = ticketSeconds;
    this.enrichPaymentRequiredResponse = this.enrichPaymentRequiredResponse.bind(this);
  }

  async parsePrice(price, network) {
    if (network !== this.network) throw new Error(`This ExactQubicServerScheme prices ${this.network}, not ${network}`);
    if (price && typeof price === "object") {
      if (price.asset !== "QUBIC") throw new Error(`Unsupported asset ${price.asset}; price in QUBIC (QU)`);
      return { amount: wholeQu(price.amount), asset: "QUBIC", extra: price.extra || {} };
    }
    if (typeof price === "number") return { amount: wholeQu(price), asset: "QUBIC", extra: {} };
    const text = String(price).trim();
    if (text.startsWith("$")) {
      if (!this.usdToQu) throw new Error(`A "$" price needs a usdToQu converter; or price in QU, e.g. "20000 QU"`);
      return { amount: wholeQu(await this.usdToQu(Number(text.slice(1)))), asset: "QUBIC", extra: {} };
    }
    const m = /^([0-9]+)\s*(QU|QUBIC)?$/i.exec(text);
    if (!m) throw new Error(`Cannot read price "${price}"; use whole QU, e.g. "20000 QU"`);
    return { amount: wholeQu(m[1]), asset: "QUBIC", extra: {} };
  }

  getAssetDecimals(asset) {
    return asset === "QUBIC" ? 0 : undefined;
  }

  async enhancePaymentRequirements(requirements, supportedKind) {
    const kindExtra = (supportedKind && supportedKind.extra) || {};
    const settlement = this.settlement || kindExtra.settlement || "direct";
    const extra = { ...(requirements.extra || {}) };
    const sellerId = extra.sellerId || requirements.payTo;
    if (!identityToBytes(sellerId)) throw new Error(`payTo (your Qubic address) must be a 60-letter Qubic identity, got ${sellerId}`);
    if (requirements.asset !== "QUBIC") throw new Error(`Unsupported asset ${requirements.asset}; price in QUBIC (QU)`);
    if (BigInt(requirements.amount) < 100n && settlement === "contract") {
      throw new Error(`Price ${requirements.amount} QU is under the QPAY contract's 100 QU minimum; buyers could never pay it`);
    }
    return {
      ...requirements,
      payTo: settlement === "contract" ? kindExtra.contractAddress || QPAY_CONTRACT_ADDRESS : sellerId,
      extra: { ...extra, sellerId, resourceId: extra.resourceId || DEFAULT_RESOURCE_ID, settlement },
    };
  }

  /** Adds a fresh ticket to every Qubic option in the 402. */
  async enrichPaymentRequiredResponse(ctx) {
    return ctx.requirements.map((r) => {
      if (!r || r.scheme !== "exact" || r.network !== this.network) return r;
      const e = r.extra || {};
      const paymentTicket = issueTicket(this.ticketKey, { sellerId: e.sellerId, resourceId: e.resourceId, amount: r.amount, seconds: this.ticketSeconds });
      return { ...r, extra: { ...e, paymentTicket } };
    });
  }
}

function wholeQu(v) {
  const s = String(v).trim();
  if (!/^[0-9]+$/.test(s) || BigInt(s) <= 0n) throw new Error(`Price must be a positive whole number of QU, got ${v}`);
  return s;
}

module.exports = { ExactQubicServerScheme, issueTicket };
