# qubic-x402-paywall

**Charge per HTTP request, in Qubic (QU).** Your API answers unpaid callers
with a `402 Payment Required`; they pay from their own wallet; you serve the
content.

Built for the [x402](https://x402.org) standard, settling through the QPAY
contract on Qubic mainnet.

- **Your traffic never leaves your server.** The facilitator only answers
  one question: *was this payment real, and is it yours?*
- **Non-custodial.** Payment goes from the buyer's wallet to yours, through
  a contract that takes the protocol fee and forwards the rest in the same
  transaction. Nobody holds your money.
- **Any language.** This package is a Node convenience. The wire protocol is
  below — implement it in Python, Go, Rust or a shell script and nothing
  changes.

You need two things from your [Q+Pay dashboard](https://useqpay.com/dashboard):
your **Qubic address** and a **ticket signing key**.

---

## The flow

```
  caller                     your server                   facilitator
    │   GET /your/api            │                              │
    ├───────────────────────────►│                              │
    │   402 + ticket             │                              │
    │◄───────────────────────────┤  (you mint the ticket)       │
    │                            │                              │
    │   calls QPAY.Pay on the contract, with the ticket's nonce  │
    ├──────────────────────────────────────────────────────────►│ chain
    │                            │                              │
    │   GET /your/api            │                              │
    │   PAYMENT-SIGNATURE: <b64> │                              │
    ├───────────────────────────►│  POST /settle                │
    │                            ├─────────────────────────────►│
    │                            │  { success: true, payer }    │
    │                            │◄─────────────────────────────┤
    │   200 + your content       │                              │
    │◄───────────────────────────┤                              │
```

---

## Why there is a ticket

A Qubic transaction hash is public the moment it is on-chain. Anyone
watching the chain can see that somebody paid you, take that hash, and try
to claim the content before the real payer does.

The ticket stops that. When you answer with a 402 you mint a **random
nonce**, before any payment exists, and hand it only to that one caller.
They must put that exact nonce **into the payment itself**. A chain-watcher
sees the payment but never saw the nonce, so they cannot claim it.

This is why you sign tickets with a key of your own, and why that key must
never leave your server.

---

## The protocol

Everything below is plain HTTP and HMAC. No Q+Pay code required.

### x402 v1 and v2 headers

Both are spoken. x402 v2 carries the payment data in headers; v1 used the
JSON body and `X-` headers. Send and accept both, so a client built for
either works:

| | v2 | v1 |
|---|---|---|
| The 402's requirements | `PAYMENT-REQUIRED` header: base64 of `{x402Version, error, resource, accepts}` | the JSON body |
| The buyer's proof | `PAYMENT-SIGNATURE` header | `X-PAYMENT` header |
| The settle result | `PAYMENT-RESPONSE` header | `X-PAYMENT-RESPONSE` header |

All header values are standard base64 (not base64url) of JSON. Mark every
402 `Cache-Control: no-store` - each one carries a single-use ticket. If
browsers call your API from another origin, expose the headers
(`Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE`).

Paying is a Qubic transaction, not a signed authorization, so a stock x402
client needs a Qubic scheme to make the payment. The `x402-qubic` package
(`npm install x402-qubic`) is that scheme: register `ExactQubicScheme` for `qubic:mainnet` with the
official `x402Client` / `@x402/fetch` and it pays any endpoint built to this
spec. Sellers already on the official `@x402/express` can use its
`ExactQubicServerScheme` instead of this package.

### 1. Answer unpaid callers with 402

The body below, and the same `{x402Version, error, resource, accepts}` as a
base64 `PAYMENT-REQUIRED` header.

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "qubic:mainnet",
    "amount": "20000",
    "asset": "QUBIC",
    "payTo": "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH",
    "maxTimeoutSeconds": 120,
    "extra": {
      "sellerId": "YOUR_QUBIC_ADDRESS",
      "resourceId": "/feed",
      "settlement": "contract",
      "paymentTicket": "<token>"
    }
  }],
  "paymentTicket": "<token>",
  "paymentTicketField": "paymentPayload.payload.ticket"
}
```

The ticket appears twice on purpose: `accepts[0].extra.paymentTicket` is
where an x402 v2 client's scheme plugin can see it (it is handed only the
option it chose), and the top-level `paymentTicket` serves older clients.

`payTo` is the **contract**, `sellerId` is **you**, and `settlement` tells the
buyer **how** to pay — never leave them to guess, because a wrong guess
under `"contract"` sends QU to a contract that has no way to return it.

Get `payTo` and `settlement` from the facilitator:
`GET https://useqpay.com/facilitator/supported` returns `settlement.name` and,
when that is `"contract"`, `settlement.contractAddress` — the address to put
in `payTo`. One field each, nothing to encode.

### 2. Mint the ticket

`base64url(claims) + "." + base64url(HMAC-SHA256(payload, yourKey))`

```json
{
  "v": "pt1",
  "sellerId": "YOUR_QUBIC_ADDRESS",
  "resourceId": "/feed",
  "amount": "20000",
  "nonce": "0123456789abcdef",
  "iat": 1790000000,
  "exp": 1790000600
}
```

| Field | Rule |
|---|---|
| `v` | exactly `"pt1"` |
| `sellerId`, `resourceId` | must equal what you put in `accepts[0]` |
| `amount` | **string**, in QU |
| `nonce` | **exactly 16 lowercase hex chars** (8 bytes) |
| `iat`, `exp` | Unix **seconds** |

Base64url with `=` padding stripped, and no spaces in the JSON. The
signature covers the encoded payload string exactly as you send it.

<details>
<summary>Python</summary>

```python
import base64, hmac, hashlib, json, os, time

def b64u(b): return base64.urlsafe_b64encode(b).decode().rstrip("=")

def issue_ticket(key, seller_id, resource_id, amount, seconds=600):
    nonce = os.urandom(8).hex()
    now = int(time.time())
    claims = {"v": "pt1", "sellerId": seller_id, "resourceId": resource_id,
              "amount": str(amount), "nonce": nonce, "iat": now, "exp": now + seconds}
    payload = b64u(json.dumps(claims, separators=(",", ":")).encode())
    sig = b64u(hmac.new(key.encode(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}", nonce
```
</details>

### 3. The caller pays

Read `extra.settlement`:

**`"contract"`** — invoke the contract's `Pay` procedure. **Not** a plain
transfer: the contract has no procedure for one, so the QU would stay there.

| | |
|---|---|
| Destination | `payTo` (the contract) |
| Amount | `amount`, in QU |
| Input type | `1` |
| Input | 72 bytes: seller pubkey (32) ‖ `SHA-256(resourceId)` (32) ‖ nonce (8) |
| Tick | at least **current tick + 20**; + 40 if a person approves in a wallet |

The seller pubkey is `extra.sellerId` decoded to its 32 bytes; the nonce is
the ticket's 16 hex characters decoded to 8 bytes **in the order written** -
do not parse them as a number and re-encode it. (The contract happens to read
those bytes as a little-endian uint64; that is its business, not a step for
you.) The contract takes the
fee and forwards the rest to the seller in the same transaction.

**`"direct"`** — a plain transfer of `amount` to `payTo`, with the ticket's
nonce (those same 8 bytes) as the transaction payload.

**The tick.** A Qubic transaction names the future tick it must land in.
Ticks are about half a second apart, so `+10` is often missed and the payment
never executes; use `+20` or more from a script, and around `+40` when a
person has to unlock a phone and approve in their wallet. Stay well inside
`maxTimeoutSeconds`.

**Use the settlement the 402 states.** Never force `"direct"` against a
facilitator that says `"contract"`: useqpay.com settles mainnet payments
through the contract only, so a direct transfer would reach the seller and
then be refused at `/settle`, leaving the caller without what they paid for.
(The sandbox is `"direct"` only.)

**Two clocks.** The ticket's `exp` (600 s after the 402 by default) is how
long the caller has to *pay*. `maxTimeoutSeconds` (120 s by default) is how
long after the payment *executes* it can still be settled, counted from the
transaction's own timestamp. So:

- When a person approves each purchase (in a chat, say), get the approval
  first, then request the resource again for a fresh 402, pay and settle at
  once. Refuse to pay if the fresh 402's price, `payTo`, `sellerId` or
  network changed.
- Don't pay a ticket that expires before you can confirm and settle;
  x402-qubic refuses one with less than its confirm timeout plus 30 s left.
- For many small purchases, a [prepaid channel](#prepaid-channels) needs one
  approval for the deposit and none per request.

**Is it on chain yet?** `GET /v2/transactions/{id}` on rpc.qubic.org is an
indexer, and it runs behind `GET /v1/tick-info`, often by 15-20 ticks. A
transaction is only missing for good once the indexer has processed past its
tick: compare with `lastProcessedTick.tickNumber` from `GET /v1/status`, never
with tick-info, or a payment that went through is reported as dropped and
paid again.

Either way the caller ends up with an ordinary **transaction id**. That is
all they send back — the facilitator reads the transaction, sees who paid,
and finds the contract's receipt itself.

### 4. They retry with proof

```http
PAYMENT-SIGNATURE: <standard base64 (not base64url) of the JSON below>
```

(`X-PAYMENT`, the v1 name, carries the same value; accept either.)

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "exact", "network": "qubic:mainnet" },
  "payload": { "txHash": "<transaction id>", "ticket": "<your token>" }
}
```

The facilitator also accepts the transaction id as `payload.reference`
(older clients send that); `txHash` is the name to use.

### 5. Settle, then serve

```http
POST https://useqpay.com/facilitator/settle
{ "paymentPayload": {...}, "paymentRequirements": {...the accepts[0] you issued...} }
```

```json
{ "success": true, "payer": "...", "transaction": "<reference>" }
```

Serve the content with the settle result as a `PAYMENT-RESPONSE` header
(base64 JSON; `X-PAYMENT-RESPONSE` for v1 clients).

**Settle before you serve.** There is also `/verify`, but it is read-only —
two concurrent requests carrying the same payment would both pass it.

**A payment settles once.** The same payment sent again — a buyer resending
the header, a double-click, two racing requests — gets
`{ "success": false, "errorReason": "payment_already_used", "transaction": "<reference>" }`.
So serve exactly when `success` is `true`, and nothing else. The
`transaction` on a repeat is there so that, if your first settle response
was lost, you can match it against your own records.

**Try it with a real wallet:** https://useqpay.com/x402/test pays any x402
endpoint from your own Qubic wallet and shows exactly what it returns - the
quickest way to check your 402, your ticket and your settle end to end.

### Rejection reasons

| Reason | Meaning |
|---|---|
| `ticket_missing` | No ticket in the payload |
| `ticket_bad_signature` | Wrong key, or `sellerId` does not match |
| `ticket_wrong_seller` / `_resource` / `_amount` | Claims disagree with `paymentRequirements` |
| `ticket_expired` | Past `exp` — issue a fresh 402 |
| `invalid_payment_nonce_mismatch` | On-chain nonce is not the one you issued |
| `invalid_transaction_state` | Transaction not found, or no QU moved — if it was only just sent, wait a few seconds and retry with the same proof |
| `invalid_exact_evm_payload_recipient_mismatch` | Paid to the wrong address (under `"contract"`, anything but the contract) |
| `invalid_exact_evm_payload_authorization_value_mismatch` | Paid a different amount than `amount` |
| `invalid_exact_evm_payload_authorization_valid_before` | Paid longer ago than `maxTimeoutSeconds` |
| `payment_already_used` | Already settled — see above |
| `invalid_payload` | No `txHash` in the payload, or it is malformed |
| `invalid_network` | Not `exact` / `qubic:mainnet` |
| `invalid_x402_version` | Not `2` |

---

## Node quickstart

```bash
npm install qubic-x402-paywall
```

```js
const express = require("express");
const { requirePayment } = require("qubic-x402-paywall");

const app = express();

app.get(
  "/feed",
  requirePayment({
    sellerId: process.env.QUBIC_ADDRESS,
    ticketKey: process.env.QPAY_TICKET_KEY, // from your dashboard
    amount: 20000,                          // QU, per request
    resourceId: "/feed",
  }),
  (req, res) => {
    // Paid. req.payment = { payer, reference, amount, resourceId }
    res.json({ data: "the goods" });
  }
);

app.listen(3000);
```

That is the whole integration. The middleware issues the 402, mints the
ticket, settles the payment and populates `req.payment`.

### Options

| Option | Default | |
|---|---|---|
| `sellerId` | — | **Required.** Your Qubic address |
| `ticketKey` | — | **Required.** From your dashboard. Never commit it |
| `amount` | — | **Required.** QU per request |
| `resourceId` | route path | Pass your own if a query parameter changes *what* is sold or its price |
| `maxTimeoutSeconds` | `120` | How long a payment stays acceptable |
| `onPaid` | — | `async (payment, req) => {}` for your own logging |
| `facilitator` | Q+Pay's | `{ url }` if you run your own |
| `channel` | — | `{ deposit }` to also offer a prepaid channel — see below |
| `network` | the facilitator's | `qubic:mainnet`, or `qubic:sandbox` on the sandbox — see below |

Also exported: `issueTicket`, `verifyTicket`, `readNonce`, `createClient`,
`resolvePayTo` — for building the flow by hand.

**Zero runtime dependencies.** Node 18+ (it uses the built-in `fetch`).

---

## Prepaid channels

Plain x402 is one on-chain payment per request: right for a person buying an
article, slow and costly for an agent calling your API five hundred times.
A **prepaid channel** takes one payment up front and then spends from it,
request by request, with no transaction and no wait.

```js
requirePayment({
  sellerId, ticketKey,
  amount: 1000,                 // QU per request, spent from the channel
  resourceId: "/quote",
  channel: { deposit: 100000 }, // what the buyer prepays, once
})
```

Your 402 then carries a `channel` offer next to the usual `accepts`, so a
one-off buyer can still pay plain x402. `req.payment` for a channel request
is `{ payer, via: "channel", channelId, remaining, amount, resourceId }`, and
the response carries `X-CHANNEL-REMAINING`.

**How it works**

1. **Deposit.** The buyer pays `deposit` QU exactly like any x402 payment,
   for the resource `channel:open`, using the ticket in the offer, and paid
   the way the offer's `requirements.extra.settlement` says (step 3 above):
   through the QPAY contract, where the fee is taken once, on the deposit, or
   under `"direct"` as a plain transfer carrying the ticket's nonce. Either
   way it reaches your wallet at once. That opens (or tops up) the channel
   `<buyer address>:<your address>`.
2. **Vouchers.** Every request carries a voucher the buyer signed with their
   wallet key: "my total spend with this seller is now *N*". The facilitator
   accepts it only when *N* is exactly the previous total plus your price,
   so a voucher pays for one request, once, and never more than the price.
3. **Top-up.** When the credit runs out, the next 402 is paid with another
   deposit on the same channel.

A channel belongs to one buyer and one seller, across all your endpoints.
Only you can redeem its vouchers: each redeem is signed with your ticket key,
so a voucher copied off the wire is worthless to anyone else.

**Trust.** The deposit is yours the moment it is paid, the same as prepaid
API credit anywhere. Unused credit is yours to refund, and buyers will only
prepay amounts they are willing to trust you with, so keep deposits modest.

### Try it

`https://useqpay.com/x402/demo/prepaid` is a live endpoint that offers a
channel: 1,000 QU a call from a 10,000 QU deposit. The agent side, in one
file with no dependency beyond `@qubic-lib/qubic-ts-library`, is
[`examples/prepaid-agent.js`](https://useqpay.com/docs/x402/prepaid-agent.js):

```bash
curl -o prepaid-agent.js https://useqpay.com/docs/x402/prepaid-agent.js
npm install @qubic-lib/qubic-ts-library
DRY_RUN=1 QUBIC_SEED=... node prepaid-agent.js https://useqpay.com/x402/demo/prepaid
QUBIC_SEED=... node prepaid-agent.js https://useqpay.com/x402/demo/prepaid 5
```

The first call pays the deposit and waits for it to confirm; the next four
are paid by voucher and return at once.

### The wire protocol

The 402 body gains:

```json
"channel": {
  "deposit": "100000",
  "price": "1000",
  "requirements": { "...": "an x402 requirement at the deposit amount, extra.resourceId = \"channel:open\"" },
  "ticket": "<ticket for the deposit>",
  "openHeader": "X-CHANNEL-OPEN",
  "voucherHeader": "X-CHANNEL-VOUCHER",
  "channelId": "<your address>:<seller address>",
  "voucherMessage": "channel:<channelId>:<cumulativeAmount>",
  "balanceUrl": "https://useqpay.com/facilitator/channel"
}
```

The buyer:

- reads their balance with `GET <balanceUrl>/<channelId>` (404 = never
  opened) → `{ deposit, spent, remaining, ... }`. Read it from a facilitator
  you trust (useqpay.com's, `https://useqpay.com/facilitator/channel`), not
  from whatever `balanceUrl` the offer names, and refuse a seller whose
  offer names another one. Never pay a deposit because of the seller's own
  answers (`X-CHANNEL-REMAINING`, the numbers in a refusal): a dishonest
  seller could say "no credit left" every time and collect a deposit per
  call. Cap the total you will deposit, too;
- if there is no channel or `remaining < price`, pays the deposit as step 3
  above says for its `extra.settlement` (a contract `Pay`, or under
  `"direct"` a plain transfer, either carrying the ticket's nonce) and sends
  `X-CHANNEL-OPEN: base64(paymentPayload)` — the same payload a
  `PAYMENT-SIGNATURE` header carries;
- signs the voucher: SchnorrQ over the KangarooTwelve-256 digest of the
  UTF-8 string `channel:<channelId>:<spent + price>`, with the wallet's key
  (`@qubic-lib/qubic-ts-library`: `K12(message, digest, 32)` then
  `schnorrq.sign(privateKey, publicKey, digest)`), and sends
  `X-CHANNEL-VOUCHER: base64({"channelId","cumulativeAmount","signature"})`,
  signature as 128 hex characters.

Send both headers on the first request; the deposit is settled first, then
the voucher is spent. While the deposit is not on chain yet the answer is
402 `invalid_transaction_state` — send the same request again. Any refused
voucher comes back with `channelState` (the facilitator's `spent` and
`deposit`) so a client that fell out of step can sign the right total.

| Reason | Meaning |
|---|---|
| `voucher_amount_mismatch` | Total is not previous spend + price (replayed or stale) |
| `voucher_exceeds_deposit` | Not enough credit left — top up |
| `voucher_bad_signature` | Not signed by the channel's buyer |
| `channel_not_found` | Never opened — send `X-CHANNEL-OPEN` |
| `not_a_channel_deposit` | The deposit was not paid for `channel:open` |

The seller side, for other languages: `POST <facilitator>/channel/open` with
`{ paymentPayload, paymentRequirements }`, and `POST
<facilitator>/channel/redeem` with `{ channelId, sellerId, price,
cumulativeAmount, signature, sellerAuth }`, where `sellerAuth` is
`hex(HMAC-SHA256(ticketKey, "redeem:<channelId>:<cumulativeAmount>:<price>"))`.
Both answer 200 `{ success: true, ... }` or 402 `{ success: false,
errorReason }`.

---

## Sandbox

`https://sandbox.useqpay.com` is a full copy of Q+Pay on an emulated
network, `qubic:sandbox`, for integrating with no real money: its own
dashboard (sign in with any wallet; API keys and ticket keys work as on
mainnet), facilitator, invoices, checkout and webhooks.

- **Network:** `qubic:sandbox`. Every Q+Pay client defaults to
  `qubic:mainnet` and refuses a 402 on any other network before signing, so
  an agent left on mainnet settings never pays a sandbox seller with real QU.
- **Selling:** point the paywall at the sandbox's facilitator,
  `facilitator: { url: "https://sandbox.useqpay.com/facilitator" }`. It reads
  the network from the facilitator, so its 402s say `qubic:sandbox`.
  Settlement is always `direct` there.
- **Paying:** use the sandbox's Qubic RPC, `https://sandbox.useqpay.com/rpc`,
  instead of `https://rpc.qubic.org`. It answers the same paths:
  `GET /v1/tick-info`, `POST /v1/broadcast-transaction`,
  `GET /v2/transactions/{id}`, `GET /v1/tx-status/{id}` and
  `GET /v1/balances/{id}`. Sign real Qubic transactions with any seed; the
  sandbox checks the signature and computes the transaction id exactly as a
  Qubic node does.
- **Test QU:** every identity has a balance of 1,000,000,000,000 QU and every
  transfer moves money. Balances are fixed: `GET /v1/balances/{id}` always
  answers that same amount, before and after a payment, so check payments
  with `GET /v2/transactions/{id}` instead. Nothing is real and nothing
  leaves the sandbox.
- **Signatures are checked:** a transaction with a bad signature is refused
  (`bad_signature`), and one naming a tick that has already passed is refused
  (`tick_passed`), as on mainnet. `GET /v1/status` reports the indexer as
  caught up, since executed transactions are visible at once.
- **Test sellers:** `https://sandbox.useqpay.com/x402/demo/prepaid` (1,000 QU,
  also offers a prepaid channel), `/api/article/content` and
  `/resource/qdoge-feed` answer 402 on `qubic:sandbox`.
- **Ticks** advance every 500 ms, about mainnet's pace, and a transaction
  executes when its tick arrives, so tick margins and "not on chain yet"
  retries behave as on mainnet.
- **Checkout:** a sandbox invoice has a "Simulate payment" button, which
  calls `POST /mock/pay` with `{ destId, amount, inputHex }` (the invoice's
  address, amount and nonce) and confirms the payment it returns. Webhooks
  are sent as on mainnet, so the webhook URL must be reachable from the
  internet.
- **Resets:** the emulated ledger lives in memory; a sandbox restart empties
  it. Accounts, keys and invoices are kept.

```js
// Buyer, official x402 client with x402-qubic, on the sandbox:
const rpcUrl = "https://sandbox.useqpay.com/rpc";
new x402Client().register(QUBIC_SANDBOX,
  new ExactQubicScheme({ signer: seedSigner(seed, { rpcUrl }), rpcUrl, network: QUBIC_SANDBOX }));
```

## Using the public facilitator

`https://useqpay.com/facilitator` is open to any seller and any buyer tool,
under the [Terms of Service](https://useqpay.com/terms). Limits, per IP
address:

| Route | Limit |
|---|---|
| `/verify`, `/settle`, `/channel/open` | 120 a minute |
| `/channel/redeem` | 3,000 a minute |
| Everything on useqpay.com together | 300 a minute |

Over a limit the answer is `429`. Back off and retry; a payment that already
executed stays settleable for `maxTimeoutSeconds`, so retry `/settle` with the
same proof rather than paying again.

## Invoices

For a checkout page instead of a 402, create an invoice with an API key
(`POST /invoice`; see [the invoice API](https://useqpay.com/docs/invoices)). Then:

- **Payout:** an invoice always pays the wallet that owns the API key. There
  is no separate payout address.
- **Status:** `GET /invoice/{invoiceId}`, no key needed. Check `status`,
  `sellerId` and `orderId` before fulfilling.
- **By transaction:** `GET /invoice/lookup/{txHash}` finds the invoice a
  payment paid, with its payer. People can check a receipt at
  https://useqpay.com/receipt.html, and every payment is also an ordinary
  transaction you can read on chain.
- **Webhooks:** `invoice.paid` and `invoice.refunded`, a JSON `POST` signed
  with `X-Qubic-X402-Signature` (hex HMAC-SHA256 of the raw body, keyed with
  the signing secret from Settings). Up to 3 attempts; deduplicate on
  `invoiceId` + `event`.
- **Sandbox:** invoices, checkout and webhooks all work there.

## What to charge

The protocol fee is **0.75%, with a floor of 100 QU**:

| Price | Fee | Net | Effective |
|---|---|---|---|
| 1,000 QU | 100 | 900 | **10%** |
| 10,000 QU | 100 | 9,900 | 1.00% |
| 100,000 QU | 750 | 99,250 | 0.75% |

**Below 13,333 QU the floor costs more than the percentage.** Price a
per-request resource at or above that and you pay the headline rate; price it
at 1,000 QU and you pay ten times it.

**Prepaid channels avoid this:** the fee is paid once, on the deposit, so a
100,000 QU deposit spent at 1,000 QU a request costs 0.75% in total.

## Keys

Your **ticket key** signs your 402s. It is not an API credential and should
never be sent anywhere. If it leaks, an attacker can forge tickets **only
for resources whose payments go to your wallet** — letting them front-run
your own buyers, and nothing else. Rotate it in the dashboard; rotating
invalidates every 402 already handed out, so do it when you are not selling.

## Licence

MIT
