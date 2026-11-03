# Q+Pay x402 packages

Open-source packages for charging and paying in Qubic (QU) over
[x402](https://useqpay.com/docs/x402), the HTTP 402 payment protocol, with
[Q+Pay](https://useqpay.com) as the facilitator.

| Package | npm | What it is |
|---|---|---|
| [`x402-qubic`](packages/x402-qubic) | [![npm](https://img.shields.io/npm/v/x402-qubic)](https://www.npmjs.com/package/x402-qubic) | The Qubic `exact` scheme for the official x402 v2 SDK. Buyers on `@x402/fetch` or any `x402Client` pay QU endpoints; sellers on `@x402/express` charge in QU. |
| [`qubic-x402-paywall`](packages/qubic-x402-paywall) | [![npm](https://img.shields.io/npm/v/qubic-x402-paywall)](https://www.npmjs.com/package/qubic-x402-paywall) | Express middleware that answers unpaid callers with a 402 and settles their payment. Its README is the protocol spec. |
| [`qpay-mcp-server`](packages/qpay-mcp-server) | [![npm](https://img.shields.io/npm/v/qpay-mcp-server)](https://www.npmjs.com/package/qpay-mcp-server) | An MCP server that lets an AI assistant pay x402 endpoints in QU, within spending limits it enforces itself. |

## Docs

- Protocol and seller guide: https://useqpay.com/docs/x402
- Invoice API: https://useqpay.com/docs/invoices
- Sandbox, with test QU and no real money: https://sandbox.useqpay.com (its
  network is `qubic:sandbox`; see "Sandbox" in the protocol docs)

## Development

```bash
npm install
npm test
```

Needs Node.js 20 or newer. Each package also tests on its own:
`npm test -w x402-qubic`.

## Contributing

Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Report security problems privately to support@useqpay.com, not in an issue.

## Licence

MIT
