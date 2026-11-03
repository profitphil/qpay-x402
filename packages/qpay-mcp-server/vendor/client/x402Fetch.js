// client/x402Fetch.js
//
// The buyer side: a drop-in fetch() that handles payment automatically.
//
//   const fetch402 = createX402Fetch({ payer });
//   const res = await fetch402("https://api.example.com/feed");
//
// Everything the manual flow made you do by hand - read the 402, work out
// the price, pay, wait for the chain, resubmit with proof - happens inside.
// The caller just gets a response.
//
// Three things this does beyond "pay when told to":
//
//   1. SESSION REUSE. If the seller issues an access grant, it is cached and
//      replayed on later calls, so a page view or a burst of API calls costs
//      one payment rather than N. Without this a naive client would pay per
//      request, which on Qubic means an on-chain transfer and a ~10s wait
//      every single time.
//
//   2. CONFIRMATION POLLING. A just-broadcast transfer is not instantly
//      queryable. "Not on chain yet" is expected, not a failure, so it is
//      retried rather than surfaced.
//
//   3. SPEND LIMITS. This is the part that matters when the buyer is an
//      autonomous agent holding a signing key. A buggy or hostile server can
//      advertise any price it likes; without a cap, "fetch this URL" can mean
//      "drain the wallet". Limits are enforced BEFORE the payer is ever
//      called, and default to refusing rather than paying.
//
// The SDK never signs anything itself - it delegates to a payer (see
// payers.js), so the same logic serves a wallet, a CLI, or a raw seed.

const DEFAULTS = {
  maxAmountPerCall: 10000, // QU. Deliberately small - opt in to more.
  // QU across this client's lifetime; null = unlimited. Inclusive: a payment
  // that brings totalSpent to exactly this value is allowed, only a payment
  // that would EXCEED it is refused. At price P, a cap of N*P allows N
  // payments, not N-1 - size the cap with that in mind.
  maxTotalSpend: null,
  confirmAttempts: 15,
  confirmIntervalMs: 3000,
  autoPay: true,
  // The one network this client pays on. A 402 for any other - the
  // sandbox's qubic:sandbox, say, reached with mainnet settings - is
  // refused before anything is signed.
  network: "qubic:mainnet",
};

class X402Error extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "X402Error";
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function decodeChallenge(body, headerValue) {
  // x402 v2 puts the requirements in a PAYMENT-REQUIRED header (base64
  // JSON); v1 and Q+Pay's own sellers also send them as the body. Read the
  // body first - it can carry more (the ticket, a channel offer) - and fall
  // back to the header for a seller that sends only that.
  let source = body;
  if ((!source || !Array.isArray(source.accepts) || source.accepts.length === 0) && headerValue) {
    try {
      source = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    } catch {
      source = null;
    }
  }
  if (!source || !Array.isArray(source.accepts) || source.accepts.length === 0) return null;
  return { requirements: source.accepts[0], resource: source.resource, raw: source };
}

// Read-only decode of a payment ticket's public claims (see
// paymentTicket.js on the server side) - just enough to learn the nonce we
// must embed on-chain. No signature check needed here: this is our own
// ticket, freshly received; if it were somehow malformed the server's own
// verifyTicket() would reject the payment anyway, so there's nothing for
// the buyer to gain by trusting a broken one. Duplicated in ~5 lines rather
// than importing the server module, which pulls in secret-signing setup
// that has no business running inside a buyer's process.
function decodeTicketNonce(ticket) {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return null;
  try {
    const claims = JSON.parse(Buffer.from(ticket.slice(0, dot), "base64url").toString("utf8"));
    return (claims && claims.nonce) || null;
  } catch {
    return null;
  }
}

function createX402Fetch(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const payer = cfg.payer;
  const fetchImpl = cfg.fetch || globalThis.fetch;

  // resourceId -> { token, expiresAt }
  const grants = new Map();
  let totalSpent = 0;

  function grantKey(url, requirements) {
    const rid = requirements && requirements.extra && requirements.extra.resourceId;
    return rid ? `${new URL(url).origin}${rid}` : new URL(url).href;
  }

  function liveGrant(key) {
    const g = grants.get(key);
    if (!g) return null;
    // 5s safety margin so a grant doesn't expire mid-flight.
    if (g.expiresAt && Date.now() / 1000 > g.expiresAt - 5) {
      grants.delete(key);
      return null;
    }
    return g;
  }

  function captureGrant(key, res) {
    const token = res.headers.get("X-ACCESS-GRANT");
    if (!token) return;
    const exp = Number(res.headers.get("X-ACCESS-GRANT-EXPIRES")) || null;
    grants.set(key, { token, expiresAt: exp });
  }

  function withHeader(init, name, value) {
    const headers = new Headers((init && init.headers) || {});
    headers.set(name, value);
    return { ...init, headers };
  }

  async function x402Fetch(url, init = {}) {
    // 1. Replay a live session before spending anything.
    const provisionalKey = new URL(url).href;
    for (const [key, g] of grants) {
      if (provisionalKey.startsWith(key.split("/").slice(0, 3).join("/")) && liveGrant(key)) {
        const res = await fetchImpl(url, withHeader(init, "X-ACCESS-GRANT", g.token));
        if (res.status !== 402) return res;
        grants.delete(key); // stale or rejected - fall through and pay
        break;
      }
    }

    let res = await fetchImpl(url, init);
    if (res.status !== 402) return res;
    if (!cfg.autoPay) return res;

    const body = await res.clone().json().catch(() => null);
    const challenge = decodeChallenge(body, res.headers.get("PAYMENT-REQUIRED"));
    if (!challenge) {
      throw new X402Error("Server returned 402 without a usable payment challenge", "bad_challenge");
    }

    const req = challenge.requirements;
    const key = grantKey(url, req);
    const amount = Number(req.amount);

    if (req.scheme !== "exact" || req.network !== cfg.network) {
      throw new X402Error(
        `This endpoint asks for payment on ${req.network} (${req.scheme}); this client pays only "exact" on ${cfg.network}. Nothing was paid.`,
        "wrong_network",
        { network: req.network, expected: cfg.network }
      );
    }

    // 2. Spend limits, enforced before the payer is called.
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new X402Error(`Server asked for an invalid amount: ${req.amount}`, "bad_amount");
    }
    if (amount > cfg.maxAmountPerCall) {
      throw new X402Error(
        `Price ${amount} QU exceeds maxAmountPerCall (${cfg.maxAmountPerCall} QU). Refusing to pay.`,
        "limit_per_call",
        { amount, limit: cfg.maxAmountPerCall }
      );
    }
    if (cfg.maxTotalSpend !== null && totalSpent + amount > cfg.maxTotalSpend) {
      throw new X402Error(
        `Paying ${amount} QU would exceed maxTotalSpend (${cfg.maxTotalSpend} QU; already spent ${totalSpent}). Refusing.`,
        "limit_total",
        { amount, totalSpent, limit: cfg.maxTotalSpend }
      );
    }
    if (!payer) {
      throw new X402Error("Payment required but no payer was configured", "no_payer", {
        amount,
        payTo: req.payTo,
      });
    }

    // The ticket's nonce must end up on-chain in this exact payment, or a
    // facilitator enforcing anti-front-running (see paymentTicket.js) will
    // reject it - a tx hash alone is a public bearer credential the moment
    // it's on-chain, so amount+recipient matching isn't proof of who paid.
    const ticket = (challenge.raw && challenge.raw.paymentTicket) || (req.extra && req.extra.paymentTicket);
    const nonceHex = decodeTicketNonce(ticket);

    // A plain transfer to the contract has no procedure to land in, so the
    // QU would be stranded there. The seed and manual payers only know how
    // to make plain transfers - refuse before any money moves rather than
    // after. A custom payer is handed `settlement` and decides for itself.
    const settlementMode = (req.extra && req.extra.settlement) || "direct";
    if (settlementMode === "contract" && (payer.name === "seed" || payer.name === "manual")) {
      throw new X402Error(
        `This endpoint settles through the QPAY contract, which needs a Pay call - the ${payer.name} payer can only send a plain transfer, and QU sent that way to the contract cannot be returned. Use contractPayer.`,
        "payer_wrong_settlement",
        { settlement: settlementMode, payer: payer.name }
      );
    }

    // 3. Pay.
    const payment = await payer.pay({
      settlement: settlementMode,
      payTo: req.payTo,
      amount,
      asset: req.asset,
      network: req.network,
      resourceId: req.extra && req.extra.resourceId,
      // Who the money is FOR, which is not payTo once a contract sits in
      // the middle - a contract payer needs it to name the seller inside
      // the Pay call. Harmless to a direct payer, which ignores it.
      sellerId: (req.extra && req.extra.sellerId) || req.payTo,
      nonceHex,
      url,
    });

    // A direct payer answers with a transaction id; a contract payer with a
    // receipt key, because that is what the facilitator reads out of
    // contract state. The server accepts either name, so pass through
    // whichever the payer produced rather than forcing one shape.
    const reference = payment && payment.reference;
    const txId = payment && (payment.txId || payment.transactionId || payment.hash);
    if (!reference && !txId) {
      throw new X402Error("Payer returned neither a reference nor a transaction id", "payer_no_txid", { payment });
    }
    totalSpent += amount;

    // 4. Resubmit with proof, tolerating the chain not having caught up.
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: challenge.resource,
        accepted: req,
        payload: reference ? { reference, ticket } : { txHash: txId, ticket },
        extensions: {},
      }),
      "utf8"
    ).toString("base64");

    for (let attempt = 1; attempt <= cfg.confirmAttempts; attempt++) {
      // PAYMENT-SIGNATURE is the x402 v2 name, X-PAYMENT the v1 one. Sent
      // under both so a seller on either version reads it.
      res = await fetchImpl(url, withHeader(withHeader(init, "PAYMENT-SIGNATURE", header), "X-PAYMENT", header));
      if (res.status !== 402) {
        captureGrant(key, res);
        return res;
      }
      const err = await res.clone().json().catch(() => ({}));
      if (err.error !== "invalid_transaction_state") {
        throw new X402Error(`Payment rejected: ${err.error}`, err.error, { txId, amount });
      }
      if (attempt < cfg.confirmAttempts) {
        await new Promise((r) => setTimeout(r, cfg.confirmIntervalMs));
      }
    }
    throw new X402Error(
      "Paid, but the transaction was not confirmed in time. It is not lost - retry with the same tx id.",
      "confirm_timeout",
      { txId, amount }
    );
  }

  x402Fetch.stats = () => ({ totalSpent, activeGrants: grants.size });
  x402Fetch.clearGrants = () => grants.clear();
  return x402Fetch;
}

module.exports = { createX402Fetch, X402Error };
