# Contributing to Copse

Thanks for wanting to help. This file is the short path; [AGENTS.md](AGENTS.md)
is the full contributor contract.

## Before you open a PR

1. Use Node **22.22.2 or newer** and **pnpm** (via Corepack). The repo pins both
   in `.nvmrc` and `packageManager`.
2. Run **`pnpm run check`**. It covers typecheck, ESLint, Prettier, dead-code
   detection, and unit tests. A green subset is not a substitute.
3. If the change is visible in the Electron app, add or update the smallest
   focused WebdriverIO spec that reaches the state, asserts the DOM, and saves a
   screenshot. A build or a manual glance is not evidence. See
   [docs/testing-strategy.md](docs/testing-strategy.md) and
   [docs/ui-taste.md](docs/ui-taste.md).

No model key is required to explore the development build: with no provider
configured, Copse uses a built-in mock agent.

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
