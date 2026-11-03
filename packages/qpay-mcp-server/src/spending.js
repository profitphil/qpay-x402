// spending.js
//
// What stands between "fetch this URL" and "empty the wallet". The price in
// a 402 is whatever the server says it is, and the model deciding to pay can
// be steered by the very page it is reading - so the limits live here, in the
// server, where neither can talk them up:
//
//   - a cap on any one request's price (and an optional lower one per call);
//   - a cap on any one prepaid deposit;
//   - a cap on everything paid in the last 24 hours, kept on disk so that a
//     host restarting the server (they do, often) does not reset it;
//   - optionally, a list of the only hosts it will pay.
//
// Every payment is written down BEFORE the payer is called, and counts
// whether or not the payer then reports success: a payer that fails after
// broadcasting has still spent the money, and from here the two cannot be
// told apart. Over-counting a failed payment is the safe direction.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const DAY_MS = 24 * 3600 * 1000;

class SpendRefused extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SpendRefused";
    this.code = code;
  }
}

function hostAllowed(allowedHosts, host) {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const h = String(host).toLowerCase();
  return allowedHosts.some((rule) => (rule.startsWith("*.") ? h.endsWith(rule.slice(1)) || h === rule.slice(2) : h === rule));
}

/**
 * @param {object} limits { maxPerCall, maxPerDay, maxDeposit, allowedHosts }
 * @param {string|null} ledgerPath JSON-lines file; null keeps it in memory (tests)
 */
function createSpending({ limits, ledgerPath, network = "qubic:mainnet", now = () => Date.now() }) {
  const entries = new Map(); // id -> entry
  if (ledgerPath && fs.existsSync(ledgerPath)) {
    for (const line of fs.readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        entries.set(rec.id, { ...(entries.get(rec.id) || {}), ...rec });
      } catch {
        // A torn last line from a crash: skip it rather than refuse to start.
      }
    }
  }

  function write(rec) {
    entries.set(rec.id, { ...(entries.get(rec.id) || {}), ...rec });
    if (!ledgerPath) return;
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(ledgerPath, JSON.stringify(rec) + "\n", { mode: 0o600 });
  }

  function spentSince(t) {
    let n = 0;
    for (const e of entries.values()) if (e.at >= t) n += e.amount;
    return n;
  }

  const spentToday = () => spentSince(now() - DAY_MS);

  // The context of the tool call a payment is made for: its URL, its own
  // price ceiling, and the payments it made (to report back).
  const callContext = new AsyncLocalStorage();

  // Check-and-reserve is one step: two calls running at once must not both
  // fit under the daily cap on the same headroom.
  let lock = Promise.resolve();
  function reserve(fields) {
    const run = lock.then(() => {
      const { amount, kind } = fields;
      const ctx = callContext.getStore() || {};
      if (!Number.isFinite(amount) || amount <= 0) throw new SpendRefused(`The server asked for an invalid amount (${amount}).`, "bad_amount");
      if (kind === "deposit") {
        if (amount > limits.maxDeposit) {
          throw new SpendRefused(`The seller wants a prepaid deposit of ${amount} QU; the limit for one deposit is ${limits.maxDeposit} QU (QPAY_MAX_DEPOSIT). Nothing was paid.`, "limit_deposit");
        }
      } else {
        const cap = Math.min(limits.maxPerCall, ctx.maxQu || Infinity);
        if (amount > cap) {
          const which = ctx.maxQu && ctx.maxQu < limits.maxPerCall ? `max_qu for this call is ${ctx.maxQu} QU` : `the limit per request is ${limits.maxPerCall} QU (QPAY_MAX_PER_CALL)`;
          throw new SpendRefused(`The price is ${amount} QU and ${which}. Nothing was paid.`, "limit_per_call");
        }
      }
      const today = spentToday();
      if (today + amount > limits.maxPerDay) {
        throw new SpendRefused(`Paying ${amount} QU would take the last 24 hours to ${today + amount} QU; the limit is ${limits.maxPerDay} QU (QPAY_MAX_PER_DAY). Nothing was paid.`, "limit_per_day");
      }
      const entry = { id: crypto.randomUUID(), at: now(), url: ctx.url || null, ...fields };
      write(entry);
      if (ctx.payments) ctx.payments.push(entry);
      return entry;
    });
    lock = run.catch(() => {});
    return run;
  }

  /** Wraps a payer so every payment goes through the limits and the ledger. */
  function guardPayer(payer) {
    return {
      ...payer,
      name: "qpay-mcp",
      async pay(req) {
        if (req.network && req.network !== network) {
          throw new SpendRefused(`This payment is on network "${req.network}"; this server pays only on ${network}.`, "wrong_network");
        }
        const entry = await reserve({
          amount: Number(req.amount),
          kind: req.resourceId === "channel:open" ? "deposit" : "payment",
          seller: req.sellerId || req.payTo || null,
          settlement: req.settlement || "direct",
        });
        try {
          const result = await payer.pay(req);
          const txId = result && (result.txId || result.transactionId || result.hash);
          write({ id: entry.id, txId: txId || null, reference: (result && result.reference) || null });
          Object.assign(entry, entries.get(entry.id));
          return result;
        } catch (err) {
          write({ id: entry.id, error: String(err && err.message ? err.message : err).slice(0, 300) });
          Object.assign(entry, entries.get(entry.id));
          throw err;
        }
      },
    };
  }

  function history({ limit, offset }) {
    const all = [...entries.values()].sort((a, b) => b.at - a.at);
    return { total: all.length, items: all.slice(offset, offset + limit) };
  }

  return {
    limits,
    guardPayer,
    callContext,
    spentToday,
    remainingToday: () => Math.max(0, limits.maxPerDay - spentToday()),
    hostAllowed: (host) => hostAllowed(limits.allowedHosts, host),
    history,
  };
}

module.exports = { createSpending, SpendRefused, hostAllowed };
