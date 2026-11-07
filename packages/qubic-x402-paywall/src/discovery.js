// Listing a paid route in the Q+Pay Directory.
//
// A seller opts in with requirePayment({ discovery: {...} }). Its 402 then
// carries two extensions:
//   - "bazaar": the x402 discovery fields (how to call the route and what
//     it returns), in the shape of the x402 Bazaar extension;
//   - "qpay-directory": the listing itself, signed with the seller's ticket
//     key, so a copy of the 402 served from any other URL fails the check.
// The facilitator fetches the URL, verifies the signature and lists it once
// a real payment for it has settled. Nothing here is secret except the key.

const crypto = require("crypto");

const CATEGORIES = ["data", "ai", "media", "tools", "finance", "search", "commerce", "other"];
const MAX_DESCRIPTION = 280;
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 24;
const MAX_URL_LENGTH = 500;
const MAX_EXAMPLE_BYTES = 2048;
const EXTENSION = "qpay-directory";

/** What the seller signs: the exact public URL and the resource it sells. */
function listingMessage(url, resourceId) {
  return `qpay-directory:v1:${url}:${resourceId}`;
}

function listingSignature(ticketKey, url, resourceId) {
  return crypto.createHmac("sha256", ticketKey).update(listingMessage(url, resourceId)).digest("hex");
}

/** Plain text on one line: control and bidi-override characters removed, spaces collapsed. */
function plainText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const tag = String(t || "").toLowerCase().trim().replace(/\s+/g, "-");
    if (/^[a-z0-9][a-z0-9-]*$/.test(tag) && tag.length <= MAX_TAG_LENGTH && !out.includes(tag)) out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

/** An example response, kept only while it is small JSON. */
function cleanExample(example) {
  if (example === undefined) return undefined;
  try {
    const text = JSON.stringify(example);
    if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_EXAMPLE_BYTES) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Checks a seller's `discovery` option once, at startup, so a mistake is an
 * error on boot rather than a listing that never appears.
 */
function normalizeOptions(discovery) {
  if (discovery == null || discovery === false) return null;
  if (typeof discovery !== "object") throw new Error("discovery must be an object, e.g. { category: \"data\" }");
  const category = discovery.category == null ? "other" : String(discovery.category);
  if (!CATEGORIES.includes(category)) throw new Error(`discovery.category must be one of: ${CATEGORIES.join(", ")}`);
  let url = null;
  if (discovery.url != null) {
    url = String(discovery.url);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("discovery.url must be an absolute URL, e.g. https://api.example.com/feed");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("discovery.url must be http(s)");
    if (parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("discovery.url takes no query string, fragment or credentials");
    if (url.length > MAX_URL_LENGTH) throw new Error(`discovery.url is longer than ${MAX_URL_LENGTH} characters`);
  }
  return {
    category,
    tags: cleanTags(discovery.tags),
    url,
    method: String(discovery.method || "GET").toUpperCase(),
    example: cleanExample(discovery.output && discovery.output.example),
    announce: discovery.announce !== false,
  };
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

/** The public URL of the route a request reached, without its query string. */
function routeUrl(req) {
  return `${req.protocol}://${req.get("host")}${req.baseUrl || ""}${req.path}`;
}

/**
 * The two 402 extensions for one listing.
 * @param {object} opts normalized options (see normalizeOptions)
 */
function buildExtensions(opts, { url, resourceId, ticketKey }) {
  return {
    bazaar: bazaarExtension(opts.method, opts.example),
    [EXTENSION]: {
      v: 1,
      url,
      resourceId,
      category: opts.category,
      tags: opts.tags,
      signature: listingSignature(ticketKey, url, resourceId),
    },
  };
}

module.exports = {
  CATEGORIES,
  EXTENSION,
  MAX_DESCRIPTION,
  MAX_URL_LENGTH,
  listingMessage,
  listingSignature,
  plainText,
  cleanTags,
  cleanExample,
  normalizeOptions,
  routeUrl,
  bazaarExtension,
  buildExtensions,
};
