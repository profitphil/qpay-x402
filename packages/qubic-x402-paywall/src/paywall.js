// The toll booth. Wrap an Express route and it answers unpaid callers with
// a 402, then verifies and settles the payment they come back with.
//
// Everything it does is described in the README's protocol section - if you
// are not on Node, implement that instead. This file is a convenience, not
// a dependency of the protocol.

const crypto = require("crypto");
const { issueTicket } = require("./ticket");
const { createClient } = require("./facilitator");
const { resolvePayTo, settlementName, networkName } = require("./payTo");

const SCHEME = "exact";
const NETWORK = "qubic:mainnet";

// x402 v2 moved the payment data into headers: the 402's requirements in
// PAYMENT-REQUIRED (base64 JSON), the buyer's proof in PAYMENT-SIGNATURE,
// the settle result in PAYMENT-RESPONSE. v1 used a JSON body, X-PAYMENT and
// X-PAYMENT-RESPONSE. Both are spoken here, so a client built for either
// works: the body stays, the headers are added, and proof is read from
// whichever header carried it.
const b64json = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const paymentHeader = (req) => req.get("PAYMENT-SIGNATURE") || req.get("X-PAYMENT");
function send402(res, body) {
  const required = { x402Version: 2, error: body.error, resource: body.resource, accepts: body.accepts };
  if (body.channel) required.extensions = { "qubic-prepaid-channel": body.channel };
  res.set("PAYMENT-REQUIRED", b64json(required));
  // Each 402 carries a single-use ticket: a cached one would hand two buyers
  // the same nonce. The official x402 SDK marks its 402s no-store too.
  res.set("Cache-Control", "no-store");
  res.append("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  return res.status(402).json(body);
}

const decodeHeader = (value) => {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
};

/**
 * @param {string} sellerId  your Qubic address
 * @param {string} ticketKey your ticket signing key (Q+Pay dashboard)
 * @param {string|number} amount  price per request, in QU
 * @param {string} resourceId  stable id for what is being sold. Defaults to
 *   the route path, which is WRONG the moment a query parameter changes what
 *   is being sold or its price - pass your own in that case.
 * @param {object} facilitator  { url } if you run your own
 * @param {object} channel  { deposit } to also offer a prepaid channel:
 *   the buyer pays `deposit` QU once, then each request spends `amount`
 *   from it with a signed voucher - no transaction per request.
 */
function requirePayment({
  sellerId,
  ticketKey,
  amount,
  resourceId,
  description = "",
  mimeType = "application/json",
  maxTimeoutSeconds = 120,
  facilitator: facilitatorOpts,
  onPaid,
  channel,
  network: networkOpt,
} = {}) {
  if (!sellerId) throw new Error("requirePayment needs sellerId (your Qubic address)");
  if (!ticketKey) throw new Error("requirePayment needs ticketKey (from your Q+Pay dashboard)");
  if (amount == null) throw new Error("requirePayment needs amount, in QU");

  if (channel && !(Number(channel.deposit) >= Number(amount))) {
    throw new Error("channel.deposit must be at least the price of one request");
  }
  const client = createClient(facilitatorOpts || {});

  return async function paywall(req, res, next) {
    const scope = resourceId || `${req.baseUrl || ""}${req.path}`;

    let payTo;
    let settlement;
    let network;
    try {
      payTo = await resolvePayTo(client, sellerId);
      settlement = await settlementName(client);
      // The facilitator's own network unless you name one: the sandbox's
      // facilitator makes this a qubic:sandbox 402 with no other change.
      network = networkOpt || (await networkName(client));
    } catch (err) {
      // Serving a 402 nobody can pay is worse than saying we are down.
      return res.status(503).json({ error: "facilitator_unreachable", detail: err.message });
    }

    const requirements = {
      scheme: SCHEME,
      network,
      amount: String(amount),
      asset: "QUBIC",
      payTo,
      maxTimeoutSeconds,
      // `settlement` tells the buyer HOW to pay - see the README. Stated so no
      // client has to guess; a wrong guess under "contract" strands the QU.
      extra: { sellerId, resourceId: scope, settlement },
    };

    // A prepaid channel's deposit is an ordinary x402 payment for the
    // resource "channel:open", at the deposit amount.
    const depositRequirements = channel
      ? { ...requirements, amount: String(channel.deposit), extra: { sellerId, resourceId: "channel:open", settlement } }
      : null;
    const channelOffer = () => {
      if (!channel) return undefined;
      const t = issueTicket(ticketKey, { sellerId, resourceId: "channel:open", amount: channel.deposit });
      return {
        deposit: String(channel.deposit),
        price: String(amount),
        requirements: depositRequirements,
        ticket: t.token,
        openHeader: "X-CHANNEL-OPEN",
        voucherHeader: "X-CHANNEL-VOUCHER",
        channelId: `<your address>:${sellerId}`,
        // Where the buyer reads their balance: GET <balanceUrl>/<channelId>
        balanceUrl: `${client.url}/channel`,
        voucherMessage: "channel:<channelId>:<cumulativeAmount>",
      };
    };
    const refuse = (error, extra = {}) =>
      send402(res, { x402Version: 2, error, accepts: [requirements], channel: channelOffer(), ...extra });

    const voucherHeader = channel && req.get("X-CHANNEL-VOUCHER");
    if (voucherHeader) return payFromChannel(req, res, next, { scope, requirements, depositRequirements, refuse, voucherHeader });

    const header = paymentHeader(req);
    if (!header) {
      const ticket = issueTicket(ticketKey, { sellerId, resourceId: scope, amount });
      return send402(res, {
        x402Version: 2,
        error: "PAYMENT-SIGNATURE header is required",
        resource: {
          url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
          description,
          mimeType,
        },
        // The ticket rides in the requirements too: an x402 v2 client hands
        // a scheme plugin only the option it chose, never the rest of the
        // 402, so this is the one place every client can find it.
        accepts: [{ ...requirements, extra: { ...requirements.extra, paymentTicket: ticket.token } }],
        paymentTicket: ticket.token,
        paymentTicketField: "paymentPayload.payload.ticket",
        channel: channelOffer(),
      });
    }

    const payload = decodeHeader(header);
    if (!payload) {
      return send402(res, { x402Version: 2, error: "invalid_payload", accepts: [requirements] });
    }

    // Settle, not just verify. verify() is read-only, so two concurrent
    // requests carrying the same payment would both pass it; only one can
    // win settle. Settling first is what makes a payment single-use.
    let result;
    try {
      result = await client.settle(payload, requirements);
    } catch (err) {
      return res.status(503).json({ error: "facilitator_unreachable", detail: err.message });
    }

    if (!result || !result.success) {
      return send402(res, {
        x402Version: 2,
        error: (result && result.errorReason) || "payment_failed",
        accepts: [requirements],
      });
    }

    const settleHeader = b64json(result);
    res.set("PAYMENT-RESPONSE", settleHeader);
    res.set("X-PAYMENT-RESPONSE", settleHeader);

    req.payment = {
      payer: result.payer,
      reference: result.transaction,
      amount: String(amount),
      resourceId: scope,
    };
    if (typeof onPaid === "function") {
      try {
        await onPaid(req.payment, req);
      } catch {
        // A logging hook must never cost a buyer the thing they paid for.
      }
    }
    return next();
  };

  /**
   * One request paid from a prepaid channel. If the request also carries
   * X-CHANNEL-OPEN, the deposit is settled and the channel opened first -
   * the buyer can sign the first voucher before the channel exists, since
   * its id is just "<their address>:<your address>".
   */
  async function payFromChannel(req, res, next, { scope, depositRequirements, refuse, voucherHeader }) {
    const voucher = decodeHeader(voucherHeader);
    if (!voucher || !voucher.channelId || voucher.cumulativeAmount == null || !voucher.signature) {
      return refuse("invalid_voucher");
    }
    try {
      const openHeader = req.get("X-CHANNEL-OPEN");
      if (openHeader) {
        const deposit = decodeHeader(openHeader);
        if (!deposit) return refuse("invalid_payload");
        const opened = await client.openChannel(deposit, depositRequirements);
        if (!opened || !opened.success) return refuse((opened && opened.errorReason) || "channel_open_failed");
      }
      const fields = { channelId: String(voucher.channelId), cumulativeAmount: String(voucher.cumulativeAmount), price: String(amount) };
      const sellerAuth = crypto
        .createHmac("sha256", ticketKey)
        .update(`redeem:${fields.channelId}:${fields.cumulativeAmount}:${fields.price}`)
        .digest("hex");
      const r = await client.redeemVoucher({ ...fields, sellerId, signature: String(voucher.signature), sellerAuth });
      if (!r || !r.success) return refuse((r && r.errorReason) || "voucher_rejected", { channelState: r && r.channel });
      res.set("X-CHANNEL-REMAINING", r.channel.remaining);
      req.payment = {
        payer: r.payer,
        via: "channel",
        channelId: r.channel.channelId,
        remaining: r.channel.remaining,
        amount: String(amount),
        resourceId: scope,
      };
    } catch (err) {
      return res.status(503).json({ error: "facilitator_unreachable", detail: err.message });
    }
    if (typeof onPaid === "function") {
      try {
        await onPaid(req.payment, req);
      } catch {
        // A logging hook must never cost a buyer the thing they paid for.
      }
    }
    return next();
  }
}

module.exports = { requirePayment, SCHEME, NETWORK };
