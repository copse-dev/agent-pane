# Contributing to Copse

Thanks for wanting to help. This file is the short path; [AGENTS.md](AGENTS.md)
is the full contributor contract.

## Before you open a PR

1. Use Node **24 or newer** and **pnpm** (via Corepack). The repo pins both in
   `.nvmrc` and `packageManager`; `nvm use` and `fnm use` both honor `.nvmrc`.
2. Run **`pnpm run check`**. It covers typecheck, ESLint, oxfmt, dead-code
   detection, and unit tests. A green subset is not a substitute.
3. If the change is visible in the Electron app, add or update the smallest
   focused WebdriverIO spec that reaches the state, asserts the DOM, and saves a
   screenshot. A build or a manual glance is not evidence. See
   [docs/testing-strategy.md](docs/testing-strategy.md) and
   [docs/ui-taste.md](docs/ui-taste.md).

No paid model key is required to explore the development build: connect a local
model, or launch with `COPSE_PANEL_MOCK_LLM=1 pnpm run dev` to use the built-in
mock agent. The mock is opt-in; an otherwise unconfigured app reports that no
provider is available.

## Licensing your contribution

Copse is licensed under [AGPL-3.0-only](LICENSE). Contributions are accepted
under that same license — what comes in matches what goes out.

Sign off every commit with `git commit -s`, which appends a trailer:

```
Signed-off-by: Your Name <you@example.com>
```

That line certifies the [Developer Certificate of Origin
1.1](https://developercertificate.org/): that you wrote the change, or have the
right to submit it under this project's license, and that you understand the
contribution and your sign-off are public and kept indefinitely.

If your employer owns the intellectual property you create, make sure you have
their permission before contributing.

## What not to file in public issues

Do **not** open a public GitHub issue for a suspected vulnerability, a leaked
key, or a reproduction that contains private source. Email
[security@copse.dev](mailto:security@copse.dev) as described in
[SECURITY.md](SECURITY.md).

Ordinary bugs and feature requests use the issue templates. Search existing
issues first. [SUPPORT.md](SUPPORT.md) lists the supported release and platform.

## Where docs live

- **[docs/user/](docs/user/)** — the user manual (install, first run, approvals,
  sandbox). Write task-shaped pages there.
- **`docs/`** (everything else) — contributor, design, and security archive.
  Do not file a user how-to at the `docs/` root.
- **`site/`** — the marketing site. HTML is the source of truth; run
  `pnpm run site:md` after editing `site/*.html`.

## Development commands

| Command             | Purpose                         |
| ------------------- | ------------------------------- |
| `pnpm run dev`      | Watch-build and launch Electron |
| `pnpm run build`    | Bundle into `dist/`             |
| `pnpm test`         | Unit and component tests        |
| `pnpm run test:e2e` | Electron end-to-end tests       |
| `pnpm run check`    | The pre-commit gate             |

More detail: [docs/agent-development.md](docs/agent-development.md).
