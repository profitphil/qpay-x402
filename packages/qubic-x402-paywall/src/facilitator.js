// Talking to the facilitator.
//
// Three calls, all plain HTTP JSON - reimplement them in any language if
// you are not on Node. The facilitator is the only part you do not run:
// it watches the chain, reads receipts out of the QPAY contract, and
// enforces that one payment settles exactly once.

const DEFAULT_URL = "https://useqpay.com/facilitator";

function createClient({ url = process.env.QPAY_FACILITATOR_URL || DEFAULT_URL, timeoutMs = 15000 } = {}) {
  const base = String(url).replace(/\/$/, "");

  async function post(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`facilitator ${path}: HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Channel calls answer a refusal with 402 and a reason the seller needs
  // (a stale voucher says where the channel stands), so those are read,
  // not thrown.
  async function postReadingRefusals(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok && res.status !== 402) throw new Error(`facilitator ${path}: HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  let supportedCache = null;
  return {
    url: base,

    /** What this facilitator settles through. Cached: it does not change
     *  between restarts, and every 402 would otherwise re-fetch it. */
    async supported() {
      if (supportedCache) return supportedCache;
      const res = await fetch(`${base}/supported`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`facilitator /supported: HTTP ${res.status}`);
      supportedCache = await res.json();
      return supportedCache;
    },

    /** Read-only. Does NOT consume the payment - see settle. */
    verify: (paymentPayload, paymentRequirements) =>
      post("/verify", { paymentPayload, paymentRequirements }),

    /** Claims the payment so it cannot be spent twice. Call this before
     *  you serve anything. */
    settle: (paymentPayload, paymentRequirements) =>
      post("/settle", { paymentPayload, paymentRequirements }),

    /** Prepaid channel: settles the deposit and opens (or tops up) the
     *  buyer's channel. Same arguments as settle. */
    openChannel: (paymentPayload, paymentRequirements) =>
      postReadingRefusals("/channel/open", { paymentPayload, paymentRequirements }),

    /** Prepaid channel: spends one request's price from a channel. The
     *  request must be signed with your ticket key - see redeemAuth. */
    redeemVoucher: ({ channelId, sellerId, price, cumulativeAmount, signature, sellerAuth }) =>
      postReadingRefusals("/channel/redeem", { channelId, sellerId, price: String(price), cumulativeAmount: String(cumulativeAmount), signature, sellerAuth }),
  };
}

module.exports = { createClient, DEFAULT_URL };
