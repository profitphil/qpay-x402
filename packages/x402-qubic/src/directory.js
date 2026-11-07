// directory.js - listing a route of the official x402 SDK in the Q+Pay
// Directory, the searchable list of paid x402 routes on Qubic.
//
//   const { qpayDirectoryListing, announceListing } = require("x402-qubic");
//   const url = "https://api.example.com/feed";
//   app.use(paymentMiddleware({ "GET /feed": {
//     accepts: { scheme: "exact", network: QUBIC_MAINNET, price: "20000 QU", payTo, extra: { resourceId: "/feed" } },
//     description: "Hourly QU/USD candles",
//     extensions: qpayDirectoryListing({ ticketKey, url, resourceId: "/feed", category: "data", tags: ["prices"] }),
//   } }, server));
//   announceListing(url); // once, at startup
//
// The facilitator fetches the URL, checks the listing is signed with your
// ticket key for that exact URL, and lists it once a payment for it has
// settled through Q+Pay. The same extensions qubic-x402-paywall emits.

const crypto = require("crypto");

const CATEGORIES = ["data", "ai", "media", "tools", "finance", "search", "commerce", "other"];
const FACILITATORS = {
  "qubic:mainnet": "https://useqpay.com/facilitator",
  "qubic:sandbox": "https://sandbox.useqpay.com/facilitator",
};

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const tag = String(t || "").toLowerCase().trim().replace(/\s+/g, "-");
    if (/^[a-z0-9][a-z0-9-]*$/.test(tag) && tag.length <= 24 && !out.includes(tag)) out.push(tag);
    if (out.length === 5) break;
  }
  return out;
}

/**
 * The x402 Bazaar extension ({ info, schema }) for a route, in the shape
 * @x402/extensions' declareDiscoveryExtension builds, so x402 tools read it.
 */
function bazaarExtension(method, example) {
  const hasExample = example !== undefined;
  return {
    info: {
      input: { type: "http", method },
      ...(hasExample ? { output: { type: "json", example } } : {}),
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: [method] } },
          required: ["type", "method"],
          additionalProperties: false,
        },
        ...(hasExample ? { output: { type: "object", properties: { type: { type: "string" }, example: {} }, required: ["type"] } } : {}),
      },
      required: ["input"],
    },
  };
}

/**
 * The route-config `extensions` that list a route.
 * @param {object} opts
 * @param {string} opts.ticketKey   your ticket key from the Q+Pay dashboard (it signs the listing; never sent)
 * @param {string} opts.url         the route's exact public URL, without a query string
 * @param {string} opts.resourceId  the same resourceId as in accepts.extra
 * @param {string} [opts.category]  one of CATEGORIES (default "other")
 * @param {string[]} [opts.tags]    up to 5 short tags
 * @param {object} [opts.output]    { example } - a small JSON example of the response
 * @param {string} [opts.method]    default "GET"
 */
function qpayDirectoryListing({ ticketKey, url, resourceId, category = "other", tags = [], output, method = "GET" } = {}) {
  if (!ticketKey) throw new Error("qpayDirectoryListing needs your ticketKey");
  if (!resourceId) throw new Error("qpayDirectoryListing needs the route's resourceId");
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error("qpayDirectoryListing needs the route's absolute public URL");
  }
  if (parsed.search || parsed.hash) throw new Error("List the route's URL without a query string or fragment");
  if (!CATEGORIES.includes(category)) throw new Error(`category must be one of: ${CATEGORIES.join(", ")}`);
  const canonical = parsed.toString();
  const signature = crypto.createHmac("sha256", ticketKey).update(`qpay-directory:v1:${canonical}:${resourceId}`).digest("hex");
  return {
    bazaar: bazaarExtension(String(method).toUpperCase(), output ? output.example : undefined),
    "qpay-directory": { v: 1, url: canonical, resourceId, category, tags: cleanTags(tags), signature },
  };
}

/**
 * Asks the facilitator to check a listed route. Resolves to its status:
 * awaiting_payment until a payment has settled, then listed; not_listed or
 * unreachable come with a reason.
 */
async function announceListing(url, { network = "qubic:mainnet", facilitatorUrl = FACILITATORS[network], timeoutMs = 15000 } = {}) {
  if (!facilitatorUrl) throw new Error(`No Q+Pay facilitator for ${network}; pass facilitatorUrl`);
  const res = await fetch(`${String(facilitatorUrl).replace(/\/$/, "")}/discovery/announce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => null);
  if (body && typeof body.status === "string") return body;
  throw new Error(`Q+Pay Directory announce: HTTP ${res.status}`);
}

module.exports = { qpayDirectoryListing, announceListing, DIRECTORY_CATEGORIES: CATEGORIES };
