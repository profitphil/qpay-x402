// client/prepaidFetch.js
//
// The buyer side of a seller's prepaid channel - for an agent calling the
// same API over and over. Plain x402 (x402Fetch.js) is one on-chain payment
// and a chain wait per request; this pays ONE deposit to the seller, then
// authorizes each request with a voucher signed locally by the wallet key:
// no transaction, no wait, no fee per request.
//
//   const fetchPrepaid = createPrepaidFetch({ payer: contractPayer({ seed }) });
//   const res = await fetchPrepaid("https://api.example.com/feed");
//
// It works against any endpoint whose 402 carries a `channel` offer (the
// qubic-x402-paywall package's requirePayment({ channel: { deposit } })).
// The first call pays the deposit and sends it along with the first
// voucher; later calls send only a voucher. When the credit runs out the
// next call pays another deposit, within the limits below.
//
// A voucher says "my total spend with this seller is now N" and is signed
// over "channel:<channelId>:<N>". The facilitator only accepts N equal to
// the previous total plus the price, so a voucher can never charge more
// than one request's price, and never twice.
//
// TRUST: the deposit is paid to the seller up front, like any prepaid
// credit. Keep deposits small with sellers you don't know - maxDeposit
// refuses anything larger before a single QU moves.
//
// Nothing the seller says can make this client pay another deposit. The
// channel balance is read only from the facilitator this client trusts
// (balanceUrl, Q+Pay's by default), never from a URL in the seller's offer,
// and the seller's X-CHANNEL-REMAINING header and error bodies are never
// believed. Otherwise a seller could report "no credit left" on every call
// and collect a fresh deposit each time. maxTotalDeposits caps the total
// anyway; by default it allows one deposit.

// Where each network's channels are kept: Q+Pay's facilitators.
const BALANCE_URLS = {
  "qubic:mainnet": "https://useqpay.com/facilitator/channel",
  "qubic:sandbox": "https://sandbox.useqpay.com/facilitator/channel",
};

const DEFAULTS = {
  maxPricePerCall: 10000, // QU per request
  maxDeposit: 100000, // QU per deposit; the seller sets the deposit, this refuses a big one
  // QU across all deposits by this client. Left out, the client pays one
  // deposit and no more. null = unlimited, for callers with their own cap.
  maxTotalDeposits: undefined,
  // The trusted facilitator's channel endpoint; left out, Q+Pay's for the network.
  balanceUrl: undefined,
  confirmAttempts: 30, // a fresh deposit is not on chain for a while
  confirmIntervalMs: 3000,
  network: "qubic:mainnet", // the one network this client pays on; see x402Fetch.js
};

class PrepaidError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "PrepaidError";
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

function decodeTicketNonce(ticket) {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return null;
  try {
    return JSON.parse(Buffer.from(ticket.slice(0, dot), "base64url").toString("utf8")).nonce || null;
  } catch {
    return null;
  }
}

function createPrepaidFetch(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const trustedBalanceUrl = String(cfg.balanceUrl || BALANCE_URLS[cfg.network] || "").replace(/\/$/, "");
  if (!trustedBalanceUrl) {
    throw new PrepaidError(`No facilitator is known for ${cfg.network}; pass balanceUrl`, "no_balance_url");
  }
  const { payer } = cfg;
  const fetchImpl = cfg.fetch || globalThis.fetch;
  if (!payer || typeof payer.signVoucher !== "function" || typeof payer.address !== "function") {
    throw new PrepaidError("prepaidFetch needs a payer that can sign vouchers (contractPayer or seedPayer)", "unsupported_payer");
  }

  // channelId -> { spent, deposit } as BigInt, mirroring the facilitator
  const channels = new Map();
  // channelId -> a paid deposit not yet accepted, so it is resent rather than paid twice
  const pendingOpens = new Map();
  let totalDeposits = 0n;
  let depositCount = 0;
  let me = null;

  function withHeaders(init, extra) {
    const headers = new Headers((init && init.headers) || {});
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return { ...init, headers };
  }

  function remember(channelId, c) {
    if (c && c.spent != null && c.deposit != null) {
      channels.set(channelId, { spent: BigInt(c.spent), deposit: BigInt(c.deposit) });
    }
  }

  /** Where the channel stands now, from the trusted facilitator - null if it has never been opened. */
  async function readBalance(channelId) {
    channels.delete(channelId);
    const r = await fetchImpl(`${trustedBalanceUrl}/${encodeURIComponent(channelId)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new PrepaidError(`Could not read the channel balance: HTTP ${r.status}`, "balance_unreadable");
    const c = await r.json();
    remember(channelId, c);
    return channels.get(channelId);
  }

  async function payDeposit(offer) {
    const req = offer.requirements;
    const deposit = BigInt(offer.deposit);
    if (deposit > BigInt(cfg.maxDeposit)) {
      throw new PrepaidError(`The seller's deposit of ${deposit} QU exceeds maxDeposit (${cfg.maxDeposit} QU). Refusing.`, "limit_deposit", { deposit: offer.deposit });
    }
    if (cfg.maxTotalDeposits === undefined && depositCount >= 1) {
      throw new PrepaidError("This client has paid its one deposit; set maxTotalDeposits to allow more. Refusing.", "limit_total", { deposit: offer.deposit });
    }
    if (cfg.maxTotalDeposits != null && totalDeposits + deposit > BigInt(cfg.maxTotalDeposits)) {
      throw new PrepaidError(`Another deposit of ${deposit} QU would exceed maxTotalDeposits (${cfg.maxTotalDeposits} QU). Refusing.`, "limit_total", { deposit: offer.deposit });
    }
    const settlement = (req.extra && req.extra.settlement) || "direct";
    if (settlement === "contract" && payer.name === "seed") {
      throw new PrepaidError("This seller settles through the QPAY contract; use contractPayer - a plain transfer to the contract cannot be returned.", "payer_wrong_settlement");
    }
    const payment = await payer.pay({
      settlement,
      payTo: req.payTo,
      amount: Number(offer.deposit),
      sellerId: req.extra && req.extra.sellerId,
      resourceId: "channel:open",
      nonceHex: decodeTicketNonce(offer.ticket),
    });
    const reference = payment && payment.reference;
    const txId = payment && (payment.txId || payment.transactionId || payment.hash);
    if (!reference && !txId) throw new PrepaidError("Payer returned neither a reference nor a transaction id", "payer_no_txid");
    totalDeposits += deposit;
    depositCount += 1;
    return b64({
      x402Version: 2,
      accepted: req,
      payload: reference ? { reference, ticket: offer.ticket } : { txHash: txId, ticket: offer.ticket },
    });
  }

  async function prepaidFetch(url, init = {}) {
    let res = await fetchImpl(url, init);
    if (res.status !== 402) return res;
    const body = await res.clone().json().catch(() => null);
    const offer = body && body.channel;
    if (!offer || !offer.requirements || !offer.price) {
      throw new PrepaidError("This endpoint does not offer a prepaid channel - use x402Fetch", "no_channel_offer");
    }
    if (offer.requirements.network !== cfg.network) {
      throw new PrepaidError(`This channel is on ${offer.requirements.network}; this client pays only on ${cfg.network}. Nothing was paid.`, "wrong_network");
    }
    const price = BigInt(offer.price);
    if (price <= 0n || price > BigInt(cfg.maxPricePerCall)) {
      throw new PrepaidError(`Price ${price} QU exceeds maxPricePerCall (${cfg.maxPricePerCall} QU). Refusing.`, "limit_per_call", { price: offer.price });
    }
    // The seller's channels must be kept where this client reads balances;
    // anywhere else, its balance reads would be wrong and it would pay again.
    if (offer.balanceUrl && String(offer.balanceUrl).replace(/\/$/, "") !== trustedBalanceUrl) {
      throw new PrepaidError(
        `This seller keeps its channels at ${offer.balanceUrl}, not at ${trustedBalanceUrl}, the facilitator this client trusts. Nothing was paid; pass balanceUrl to trust it.`,
        "untrusted_facilitator"
      );
    }
    const sellerId = offer.requirements.extra && offer.requirements.extra.sellerId;
    me = me || (await payer.address());
    const channelId = `${me}:${sellerId}`;

    let state = channels.get(channelId) || (await readBalance(channelId));
    let openHeader = pendingOpens.get(channelId) || null;
    if (!openHeader && (!state || state.deposit - state.spent < price)) {
      openHeader = await payDeposit(offer);
      pendingOpens.set(channelId, openHeader);
    }

    let resynced = false;
    for (let attempt = 1; attempt <= cfg.confirmAttempts; attempt++) {
      const spent = state ? state.spent : 0n;
      const cumulative = (spent + price).toString();
      const { signature } = await payer.signVoucher(`channel:${channelId}:${cumulative}`);
      const headers = { "X-CHANNEL-VOUCHER": b64({ channelId, cumulativeAmount: cumulative, signature }) };
      if (openHeader) headers["X-CHANNEL-OPEN"] = openHeader;

      res = await fetchImpl(url, withHeaders(init, headers));
      if (res.status !== 402) {
        if (res.ok) {
          // Our own bookkeeping, not the seller's X-CHANNEL-REMAINING: the
          // deposit grows only by deposits this client paid.
          const deposit = (state ? state.deposit : 0n) + (openHeader ? BigInt(offer.deposit) : 0n);
          channels.set(channelId, { spent: BigInt(cumulative), deposit });
          pendingOpens.delete(channelId);
        }
        return res;
      }
      const err = await res.clone().json().catch(() => ({}));
      // A deposit that is not on chain yet: wait and send the same thing again.
      if (openHeader && err.error === "invalid_transaction_state") {
        await new Promise((r) => setTimeout(r, cfg.confirmIntervalMs));
        continue;
      }
      // Out of step (another process spending from the same channel, a
      // restart): read the trusted facilitator again, never the numbers in
      // the seller's answer, and sign once more.
      if (!resynced && ["voucher_amount_mismatch", "voucher_exceeds_deposit"].includes(err.error)) {
        resynced = true;
        state = await readBalance(channelId);
        if (!openHeader && (!state || state.deposit - state.spent < price)) {
          openHeader = await payDeposit(offer);
          pendingOpens.set(channelId, openHeader);
        }
        continue;
      }
      throw new PrepaidError(`Voucher refused: ${err.error}`, err.error, { channelId });
    }
    throw new PrepaidError("The deposit was paid but not confirmed in time. It is not lost - the next call sends it again.", "confirm_timeout", { channelId });
  }

  prepaidFetch.stats = () => ({
    totalDeposits: totalDeposits.toString(),
    channels: [...channels].map(([channelId, c]) => ({ channelId, deposit: c.deposit.toString(), spent: c.spent.toString(), remaining: (c.deposit - c.spent).toString() })),
  });
  return prepaidFetch;
}

module.exports = { createPrepaidFetch, PrepaidError };
