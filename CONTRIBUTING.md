# Contributing

Thanks for helping. A few things make a pull request easy to take:

- **Open it against `main`** and keep it to one change. Don't push to
  `main` directly.
- **Tests:** add one for what you change, and run `npm test` before you open
  the pull request. The tests use Node's own runner (`node --test`) and need
  no network.
- **Dependencies:** please ask in an issue before adding a runtime
  dependency. These packages run inside other people's wallets and servers,
  so fewer is better.
- **Money paths:** anything that signs or sends a payment should refuse
  before signing when something is off (wrong network, wrong contract,
  a ticket that doesn't match, a limit exceeded), and should never report
  "nothing was paid" unless that is certain.

## How changes get here

These packages are developed in Q+Pay's main codebase, alongside the
facilitator they talk to, and mirrored here at each release. When a pull
request is merged, we apply it there too, and it comes back with the next
sync. Q+Pay publishes the npm releases.

## Security

Please report security problems privately to support@useqpay.com rather
than in a public issue.
