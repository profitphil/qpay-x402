# x402-qubic

**Pay x402 endpoints in Qubic (QU) with the official x402 v2 client.**

If you already use `@x402/fetch`, `@x402/axios` or `x402Client` from `@x402/core`, register this one scheme and your client can pay any `qubic:mainnet` endpoint, including every [Q+Pay](https://useqpay.com) seller.

```js
const { x402Client } = require("@x402/core/client");
const { wrapFetchWithPayment } = require("@x402/fetch");
const { ExactQubicScheme, seedSigner, QUBIC_MAINNET } = require("x402-qubic");

const client = new x402Client()
  .register(QUBIC_MAINNET, new ExactQubicScheme({ signer: seedSigner(process.env.QUBIC_SEED) }))
  // QU is not one of the SDK's default assets, so opt in, with a cap in QU.
  .setSpendControls({ allowedAssets: [{ network: QUBIC_MAINNET, asset: "QUBIC", maxAmountPerPayment: "10000" }] });

const fetchWithPay = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPay("https://api.example.com/feed");
```

Requires Node 20+, `@x402/core` 2.28+ and `@qubic-lib/qubic-ts-library`.

## Selling: charge in QU with the official @x402/express

`ExactQubicServerScheme` lets a seller already on the official x402 SDK charge in QU through the [Q+Pay](https://useqpay.com) facilitator.

```js
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactQubicServerScheme, QUBIC_MAINNET } = require("x402-qubic");

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://useqpay.com/facilitator" }))
  .register(QUBIC_MAINNET, new ExactQubicServerScheme({ ticketKey: process.env.QPAY_TICKET_KEY }));

const app = express();
app.use(paymentMiddleware({
  "GET /feed": {
    accepts: { scheme: "exact", network: QUBIC_MAINNET, price: "20000 QU", payTo: process.env.QUBIC_ADDRESS, extra: { resourceId: "/feed" } },
    description: "Market feed",
  },
}, server));
app.get("/feed", (req, res) => res.json({ data: "the goods" }));
```

You need two things from your [Q+Pay dashboard](https://useqpay.com/dashboard): your Qubic address (`payTo`) and your ticket signing key. Keep the key secret.

- **Prices** are whole QU: `"20000 QU"`, `20000` or `{ amount: "20000", asset: "QUBIC" }`. For `"$1.50"` pass a `usdToQu` converter to the constructor.
- **Settlement** is read from the facilitator. Under contract settlement (what useqpay.com runs) buyers pay the QPAY contract, which keeps the 0.75% fee (100 QU minimum) and forwards the rest to you in the same transaction. Your address moves to `extra.sellerId`. Prices under 100 QU are refused at startup, since no buyer could pay them.
- **Tickets**: every 402 gets a fresh one-time ticket in `accepts[].extra.paymentTicket`. Its nonce must ride in the buyer's transaction, which stops anyone watching the chain from claiming a payment.
- **`extra.resourceId`** names what a route sells. Give each route its own; it defaults to `"x402"`.
- **Flow**: the payment is settled before your handler runs, so a payment is served once.

## How it pays

On EVM, an x402 payment is a signed authorization the facilitator executes later. Qubic has no such thing, so this scheme pays directly:

1. It reads the option the client chose (`accepts[i]`): the price, `payTo`, and `extra.settlement`, `extra.sellerId`, `extra.resourceId` and the seller's one-time `extra.paymentTicket`.
2. It sends a Qubic transaction from your wallet. Under `"contract"` settlement that is a call to the QPAY contract's `Pay` procedure (input type 1: seller ‖ SHA-256(resourceId) ‖ the ticket's nonce), which keeps the 0.75% fee (100 QU minimum) and forwards the rest to the seller. Under `"direct"` it is a transfer to `payTo` carrying the nonce.
3. It waits until the network has executed the transaction, then returns `{ txHash, ticket }` for the client to send as `PAYMENT-SIGNATURE`.

The nonce in the transaction is what stops anyone watching the chain from claiming your payment first.

## What it refuses, before signing anything

- A price over the cap from the client's spend controls.
- An option that is not `exact` on `qubic:mainnet` in `QUBIC`, or an amount that is not a whole number of QU.
- A missing ticket, a ticket whose seller, resource or amount disagrees with the option, or one that expires before the payment could confirm and settle (less than `confirmTimeoutMs` plus 30 s left).
- Contract settlement without `extra.resourceId`: the receipt would name no resource, and the seller would refuse a payment already made.
- Contract settlement aimed at any address other than the QPAY contract (`DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH`), since QU sent with a `Pay` input anywhere else would be lost.

If the network never executes the transaction, the payment fails with `payment_dropped`, nothing paid and no proof sent. It is only called dropped once the RPC's indexer (`GET /v1/status`) has processed past its tick, so a slow indexer is waited for instead of inviting a second payment. If the indexer does not report its progress, the payment ends in `confirm_timeout` instead: it may still land, so check it before paying again.

## Signers

`seedSigner(seed)` holds a Qubic seed and spends from it on its own. Anything holding the seed can move the whole balance, so use a wallet funded with only what you mean to spend. Any object with `address()` and `send({ to, amount, inputType, input, tick })` returning a transaction id can stand in for it: a hardware signer, a custodial service or a test double. For prepaid channels it also needs `signVoucher(message)`, returning the 128-hex SchnorrQ signature; `seedSigner` signs only vouchers for its own channels (`channel:<this wallet>:<seller>:<total>`).

## Prepaid channels

For an agent calling the same seller over and over, a [prepaid channel](https://useqpay.com/docs/x402#prepaid-channels) pays one deposit, then each call with a voucher signed locally: no transaction, no wait, no fee per call.

```js
const { createChannelFetch, seedSigner } = require("x402-qubic");

const channelFetch = createChannelFetch({
  signer: seedSigner(process.env.QUBIC_SEED),
  maxDeposit: 100000,    // QU; a bigger deposit is refused before anything is signed
  maxPricePerCall: 1000, // QU
});
const res = await channelFetch("https://api.example.com/feed");
```

- The deposit is paid through `ExactQubicScheme`, so it gets every check above, and follows `extra.settlement` (a contract `Pay` only to the QPAY contract, a plain transfer under `"direct"`).
- **A deposit belongs to the seller once paid**; unused credit comes back only if the seller refunds it. `maxTotalDeposits` caps all deposits over the client's life and defaults to `maxDeposit`, one deposit's worth; raise it to allow top-ups. A deposit refused before signing, or dropped by the network, does not count against it; one that may still land (`confirm_timeout`) does.
- Balances are read from the network's Q+Pay facilitator only (or `balanceUrl`), never from a URL in the seller's offer, and a seller's 402 never triggers a deposit on its own say-so.
- An offer whose deposit is below its price is refused before paying.
- A 402 without a channel offer is returned untouched, so you can hand it to `wrapFetchWithPayment`.
- Refusals throw a `ChannelError` with a `code` (`limit_deposit`, `limit_total`, `limit_per_call`, `untrusted_balance_url`, `voucher_exceeds_deposit`, ...).

## Options

`new ExactQubicScheme({ signer, rpcUrl, network, tickOffset, confirmTimeoutMs, pollMs, contractAddresses })`: Qubic RPC (default `https://rpc.qubic.org`), the network it pays on (default `QUBIC_MAINNET`; options on any other network are refused), ticks to target ahead (default 30, about 15 s), how long to wait for execution (default 90 s), and the addresses accepted as `payTo` under contract settlement. `ExactQubicServerScheme` takes `network` too.

## Sandbox

`https://sandbox.useqpay.com` runs Q+Pay on an emulated network, `qubic:sandbox`, with test QU in every wallet. Register for `QUBIC_SANDBOX` and point the signer and the scheme at its RPC:

```js
const { ExactQubicScheme, seedSigner, QUBIC_SANDBOX } = require("x402-qubic");
const rpcUrl = "https://sandbox.useqpay.com/rpc";
const client = new x402Client()
  .register(QUBIC_SANDBOX, new ExactQubicScheme({ signer: seedSigner(seed, { rpcUrl }), rpcUrl, network: QUBIC_SANDBOX }))
  .setSpendControls({ allowedAssets: [{ network: QUBIC_SANDBOX, asset: "QUBIC", maxAmountPerPayment: "10000" }] });
```

Sellers register `new ExactQubicServerScheme({ ticketKey, network: QUBIC_SANDBOX })` with the facilitator `https://sandbox.useqpay.com/facilitator`. A client registered for `QUBIC_MAINNET` never pays a sandbox seller.

## Notes

- A paid request waits for the network to execute the payment, a few seconds. For many calls to one API, a seller's prepaid channel is faster; see the [seller spec](https://useqpay.com/docs/x402).
- Payments under 100 QU are refused by the QPAY contract.
- The x402 wire format (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE) is standard; what this package adds is the Qubic payment itself.
