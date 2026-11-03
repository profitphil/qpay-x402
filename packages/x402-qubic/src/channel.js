// channel.js - the buyer side of Q+Pay prepaid channels, for an agent that
// calls the same seller over and over.
//
//   const { createChannelFetch, seedSigner, QUBIC_MAINNET } = require("x402-qubic");
//   const channelFetch = createChannelFetch({
//     signer: seedSigner(process.env.QUBIC_SEED),
//     maxDeposit: 100000,     // refuse a bigger deposit before anything is signed
//     maxPricePerCall: 1000,  // refuse a bigger price per call
//   });
//   const res = await channelFetch("https://api.example.com/feed");
//
// The first call pays the seller's deposit (exactly like an x402 payment, for
// the resource "channel:open", through ExactQubicScheme so every check it makes
// before signing applies) and sends it with the first voucher. Later calls send
// only a voucher: "my total spend with this seller is now N", signed with the
// wallet key. No transaction, no wait, no fee per call.
//
// When the 402 carries no channel offer, the 402 response is returned as is,
// so the caller can pay it with wrapFetchWithPayment instead.
//
// TRUST: a deposit belongs to the seller once paid; unused credit is refunded
// by the seller, if at all, outside the protocol. So:
//   - deposits are bounded by maxDeposit, and by maxTotalDeposits over the
//     life of this client (default: one deposit's worth);
//   - the channel's balance is read only from the Q+Pay facilitator of the
//     network (or the balanceUrl you pass), never from a URL in the offer, and
//     a seller's 402 never triggers a deposit on its own say-so;
//   - vouchers never total more than the facilitator's deposit plus the
//     deposit this client just paid.

const { ExactQubicScheme, QUBIC_MAINNET, QUBIC_SANDBOX, identityToBytes } = require("./scheme");

const CHANNEL_RESOURCE_ID = "channel:open";
const OPEN_HEADER = "X-CHANNEL-OPEN";
const VOUCHER_HEADER = "X-CHANNEL-VOUCHER";
const BALANCE_URLS = {
  [QUBIC_MAINNET]: "https://useqpay.com/facilitator/channel",
  [QUBIC_SANDBOX]: "https://sandbox.useqpay.com/facilitator/channel",
};

class ChannelError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const isWholeQu = (v, allowZero = false) => /^[0-9]+$/.test(String(v)) && (allowZero || BigInt(v) > 0n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The voucher message the facilitator verifies. Built here, never taken from the seller. */
function voucherMessage(channelId, cumulative) {
  return `channel:${channelId}:${cumulative}`;
}

/** The offer of a 402 body, checked; throws ChannelError when anything is off. null when there is none. */
function readOffer(body, network, balanceUrl) {
  const offer = body && body.channel;
  if (!offer) return null;
  const req = offer.requirements || {};
  const extra = req.extra || {};
  if (req.scheme !== "exact" || req.network !== network || req.asset !== "QUBIC") {
    throw new ChannelError(`The channel offer is not a QU payment on ${network}; nothing was paid`, "unsupported_requirements");
  }
  if (offer.balanceUrl !== balanceUrl) {
    throw new ChannelError(`The channel offer points to ${offer.balanceUrl}, not the facilitator ${balanceUrl}; nothing was paid`, "untrusted_balance_url");
  }
  if (!isWholeQu(offer.price) || !isWholeQu(offer.deposit) || String(req.amount) !== String(offer.deposit)) {
    throw new ChannelError("The channel offer's price or deposit is invalid; nothing was paid", "invalid_offer");
  }
  if (extra.resourceId !== CHANNEL_RESOURCE_ID) throw new ChannelError(`The deposit is not for "${CHANNEL_RESOURCE_ID}"; nothing was paid`, "invalid_offer");
  if (!identityToBytes(extra.sellerId)) throw new ChannelError(`Seller id ${extra.sellerId} is not a Qubic identity`, "invalid_seller");
  if (typeof offer.ticket !== "string") throw new ChannelError("The channel offer has no deposit ticket", "ticket_missing");
  return {
    sellerId: extra.sellerId,
    price: BigInt(offer.price),
    deposit: BigInt(offer.deposit),
    // ExactQubicScheme reads the ticket where a 402 option carries it.
    requirements: { ...req, extra: { ...extra, paymentTicket: offer.ticket } },
  };
}

/**
 * @param {object} opts
 * @param {object} opts.signer             { address(), send(), signVoucher(message) } - see seedSigner()
 * @param {number|string} opts.maxDeposit  refuse a deposit larger than this, in QU
 * @param {number|string} opts.maxPricePerCall refuse a price per call larger than this, in QU
 * @param {number|string} [opts.maxTotalDeposits] cap on all deposits paid by this client (default: maxDeposit)
 * @param {string} [opts.network]          qubic:mainnet (default) or qubic:sandbox
 * @param {string} [opts.rpcUrl]           Qubic RPC for the deposit
 * @param {string} [opts.balanceUrl]       where channel balances are read; defaults to the network's Q+Pay facilitator
 * @param {object} [opts.schemeOptions]    passed to ExactQubicScheme (tickOffset, confirmTimeoutMs, ...)
 * @param {Function} [opts.fetch]
 */
function createChannelFetch(opts = {}) {
  const { signer, network = QUBIC_MAINNET, rpcUrl, schemeOptions = {}, confirmAttempts = 30, confirmIntervalMs = 3000 } = opts;
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!signer || typeof signer.address !== "function" || typeof signer.signVoucher !== "function") {
    throw new ChannelError("createChannelFetch needs a signer with address() and signVoucher() (see seedSigner)", "unsupported_signer");
  }
  if (opts.maxDeposit == null || opts.maxPricePerCall == null) {
    throw new ChannelError("createChannelFetch needs maxDeposit and maxPricePerCall, in QU", "limits_required");
  }
  const maxDeposit = BigInt(opts.maxDeposit);
  const maxPricePerCall = BigInt(opts.maxPricePerCall);
  const maxTotalDeposits = BigInt(opts.maxTotalDeposits ?? opts.maxDeposit);
  const balanceUrl = (opts.balanceUrl || BALANCE_URLS[network] || "").replace(/\/$/, "");
  if (!balanceUrl) throw new ChannelError(`No facilitator balance URL known for ${network}; pass balanceUrl`, "balance_url_required");
  const scheme = new ExactQubicScheme({ ...schemeOptions, signer, network, ...(rpcUrl ? { rpcUrl } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });

  let totalDeposits = 0n;
  // channelId -> { header, amount }: a paid deposit not yet accepted, sent again rather than paid twice.
  const pendingOpens = new Map();

  async function readBalance(channelId) {
    const r = await fetchImpl(`${balanceUrl}/${encodeURIComponent(channelId)}`, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return { spent: 0n, deposit: 0n };
    if (!r.ok) throw new ChannelError(`Could not read the channel balance: HTTP ${r.status}; nothing was paid`, "balance_unreadable");
    const c = await r.json();
    if (!isWholeQu(c.spent, true) || !isWholeQu(c.deposit, true)) throw new ChannelError("The facilitator returned an invalid balance", "balance_unreadable");
    return { spent: BigInt(c.spent), deposit: BigInt(c.deposit) };
  }

  async function payDeposit(offer) {
    if (offer.deposit > maxDeposit) {
      throw new ChannelError(`The seller's deposit of ${offer.deposit} QU is over maxDeposit (${maxDeposit} QU); nothing was paid`, "limit_deposit");
    }
    if (totalDeposits + offer.deposit > maxTotalDeposits) {
      throw new ChannelError(`Another deposit of ${offer.deposit} QU would pass maxTotalDeposits (${maxTotalDeposits} QU); nothing was paid`, "limit_total");
    }
    // Reserved before paying: a failure after signing must not free room for a second deposit.
    totalDeposits += offer.deposit;
    const { x402Version, payload } = await scheme.createPaymentPayload(2, offer.requirements, { maxAmountPerPayment: offer.deposit.toString() });
    return { header: b64({ x402Version, accepted: offer.requirements, payload }), amount: offer.deposit };
  }

  async function signVoucher(channelId, cumulative) {
    const signed = await signer.signVoucher(voucherMessage(channelId, cumulative));
    const signature = typeof signed === "string" ? signed : signed && signed.signature;
    if (typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) {
      throw new ChannelError("The signer returned no valid voucher signature", "bad_signer");
    }
    return b64({ channelId, cumulativeAmount: cumulative.toString(), signature });
  }

  return async function channelFetch(url, init = {}) {
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return first;
    const offer = readOffer(await first.clone().json().catch(() => null), network, balanceUrl);
    if (!offer) return first;
    if (offer.price > maxPricePerCall) {
      throw new ChannelError(`Price ${offer.price} QU is over maxPricePerCall (${maxPricePerCall} QU); nothing was paid`, "limit_per_call");
    }

    const channelId = `${await signer.address()}:${offer.sellerId}`;
    let state = await readBalance(channelId);
    let open = pendingOpens.get(channelId) || null;
    if (!open && state.deposit - state.spent < offer.price) {
      open = await payDeposit(offer);
      pendingOpens.set(channelId, open);
    }

    let resynced = false;
    for (let attempt = 1; attempt <= confirmAttempts; attempt++) {
      const cumulative = state.spent + offer.price;
      // Never more than the facilitator's deposit plus the one paid just now.
      if (cumulative > state.deposit + (open ? open.amount : 0n)) {
        throw new ChannelError(`Not enough prepaid credit for ${offer.price} QU; nothing more was signed`, "voucher_exceeds_deposit", { channelId });
      }
      const headers = new Headers(init.headers || {});
      headers.set(VOUCHER_HEADER, await signVoucher(channelId, cumulative));
      if (open) headers.set(OPEN_HEADER, open.header);

      const res = await fetchImpl(url, { ...init, headers });
      if (res.status !== 402) {
        if (res.ok) pendingOpens.delete(channelId);
        return res;
      }
      const err = await res.clone().json().catch(() => ({}));
      // A deposit not on chain yet: wait and send the same thing again.
      if (open && err.error === "invalid_transaction_state") {
        await sleep(confirmIntervalMs);
        continue;
      }
      // Out of step: re-read the facilitator (not the seller's channelState) and sign once more.
      if (!resynced && ["voucher_amount_mismatch", "voucher_exceeds_deposit"].includes(err.error)) {
        resynced = true;
        state = await readBalance(channelId);
        continue;
      }
      throw new ChannelError(`Voucher refused: ${err.error || `HTTP ${res.status}`}`, err.error || "voucher_refused", { channelId });
    }
    throw new ChannelError("The deposit was paid but not accepted in time. It is not lost: the next call sends it again.", "confirm_timeout", { channelId });
  };
}

module.exports = { createChannelFetch, ChannelError, voucherMessage, BALANCE_URLS };
