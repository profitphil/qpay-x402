# qpay-mcp-server

An MCP server that lets an AI assistant (Claude Desktop, Claude Code, Cursor and any other MCP host) pay for HTTP endpoints that charge in Qubic (QU) through [x402](https://useqpay.com/docs/x402) and [Q+Pay](https://useqpay.com). The assistant asks for a URL; if the URL answers `402 Payment Required`, this server pays it from a wallet it holds and returns the response.

The server enforces the spending limits itself. Neither the endpoint, which sets its own price, nor the model, which can be steered by what it reads, can raise them.

## Tools

| Tool | What it does |
|---|---|
| `qpay_check_price` | Requests a URL without paying. Reports the price per request, how long one payment gives access, any prepaid-channel offer, and whether the limits would allow paying. |
| `qpay_fetch` | Requests a URL and pays if it answers 402. Takes `max_qu` to bound one call. Uses the seller's prepaid channel when offered: one deposit, then no transaction per call. |
| `qpay_wallet_status` | Shows the wallet address, its balance, the limits, what was paid in the last 24 hours, and prepaid credit held with sellers. |
| `qpay_spending_history` | Lists every payment, newest first, with its transaction id. |

## Set up

1. **Make a wallet just for the assistant**, and put in only what you're willing to let it spend. The seed is a spending key, and anything holding it can move the whole balance.
2. Add the server to your MCP host:

**Claude Code**

```bash
claude mcp add qpay -e QPAY_MCP_SEED=yourfiftyfivelowercaseletterseed -e QPAY_MAX_PER_DAY=100000 -- npx -y qpay-mcp-server
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and most other hosts:

```json
{
  "mcpServers": {
    "qpay": {
      "command": "npx",
      "args": ["-y", "qpay-mcp-server"],
      "env": {
        "QPAY_MCP_SEED": "yourfiftyfivelowercaseletterseed",
        "QPAY_MAX_PER_CALL": "10000",
        "QPAY_MAX_PER_DAY": "100000"
      }
    }
  }
}
```

Without `QPAY_MCP_SEED` the server still starts: prices can be checked, and nothing can be paid.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `QPAY_MAX_PER_CALL` | `10000` | Most QU one request may cost. `max_qu` on a call can lower it, never raise it. |
| `QPAY_MAX_DEPOSIT` | `50000` | Most QU one prepaid-channel deposit may be. |
| `QPAY_MAX_PER_DAY` | `100000` | Most QU paid in any 24 hours, deposits included. |
| `QPAY_ALLOWED_HOSTS` | any | Comma-separated hosts it may pay, e.g. `api.example.com,*.useqpay.com`. |
| `QPAY_MCP_DATA_DIR` | `~/.qpay-mcp` | Where the payment ledger is kept. |
| `QUBIC_RPC_URL` | `https://rpc.qubic.org` | Qubic RPC used to sign and broadcast. |
| `QPAY_MCP_NETWORK` | `qubic:mainnet` | The one network it pays on. A 402 for any other is refused before anything is signed. |

**Sandbox.** To try it with no real money, run it against the sandbox's emulated network: `QPAY_MCP_NETWORK=qubic:sandbox` and `QUBIC_RPC_URL=https://sandbox.useqpay.com/rpc`, with any seed (every identity there holds test QU). It then pays only `qubic:sandbox` sellers, for example ones built on the sandbox at `https://sandbox.useqpay.com`, and a mainnet server never pays them. See the Sandbox section of the [seller spec](https://useqpay.com/docs/x402).

Each payment is checked against these limits before the payer is called, so a refusal moves no money. Each payment is also written to the ledger first and counts toward the 24-hour limit even if the payer then reports an error, since the transaction may already have been broadcast. The 24-hour total is read back from the ledger, so it survives the host restarting the server.

Your MCP host will usually ask you to approve each `qpay_fetch` call; it is marked as an action with side effects. Leave that approval on unless the limits above are small enough that you don't need it.

## How payment works

- **Per request:** the endpoint's 402 names the price, the seller and how it settles. Under contract settlement (what useqpay.com uses), the payment is a `Pay` call into the QPAY contract, which takes the 0.75% fee (100 QU minimum) and passes the rest to the seller in the same transaction. Under direct settlement, it's a plain transfer to the seller. Either way the transaction carries the 402's one-time ticket, so nobody watching the chain can claim the payment first.
- **Access grants:** if the seller gives a grant with the response, later calls inside it are served without paying again.
- **Prepaid channels:** if the seller offers one, the first call pays one deposit and later calls send a voucher signed by the wallet key, with no transaction and no wait. The prepaid credit is shown in `qpay_wallet_status`.

## Safety

- Fetched content is returned to the model labeled as third-party content. The server's instructions tell the model never to follow instructions inside it, or to pay because a fetched page asks.
- The seed only ever lives in this process's environment. It is never logged and never returned by a tool.

Spec and seller side: <https://useqpay.com/docs/x402> · Seller package: `qubic-x402-paywall`
