# REVIEW.md

Guidance for automated reviewers of this repository (Copse Reviewer and any other). It is
read from the base branch, so a pull request cannot change the rules it is reviewed
against. Keep it short. When the same finding keeps coming back, fix it at the source: here,
in [`AGENTS.md`](AGENTS.md), in a lint rule or in a test.

Copse is an Electron desktop AI coding assistant. The main process talks directly to model
providers and runs agent-proposed shell commands, so most expensive bugs are about trust,
persisted data and turns that never end.

## What failure looks like here

- **Shell permissions and sandboxing:** a command runs without a prompt when it should prompt,
  a grant outlives its thread or widens its scope, or a failure leaves access open instead of
  closed. The contract is [`docs/shell-permissions.md`](docs/shell-permissions.md).
- **Persisted data:** an older profile under `~/.copse/` stops loading, a thread or setting is
  lost or rewritten, a migration is one-way without saying so, or a secret is written in
  plaintext. See [`docs/thread-store-format.md`](docs/thread-store-format.md).
- **Agent loop, hooks and IPC:** a turn that never finishes, continues without the user, drops
  or duplicates events, or diverges from the decisions log in
  [`docs/plans/hooks-and-feature-packs.md`](docs/plans/hooks-and-feature-packs.md).
- **Credentials and CI:** a token, key or the user's environment can reach code the user did
  not write (a dependency script, a pull request's code, a model's tool call), or a workflow
  runs untrusted code with write permissions.
- **Renderer:** a visible regression (clipped, overlapping, missing or unreadable) in a state
  users reach. A user-visible change with no focused visual eval breaks an `AGENTS.md` rule.
- **Test-only product API:** an option, field or flag that only tests write. See
  [`docs/testing-strategy.md`](docs/testing-strategy.md#tests-must-not-create-product-api).

## What is not a finding

- Style, formatting, naming or wording. The linter and formatter own those.
- Anything `pnpm run typecheck` or `pnpm run lint` already reports.
- A missing test, unless the change breaks behaviour that no test would catch.
- An issue the change did not introduce. If it is serious, say plainly that it predates the
  change and why it matters now.
- A type-safety rule from `AGENTS.md` broken without a defect. Flag the cast, `in` check or
  untyped JSON parse only when it hides a real bug.

Raise at most two low-severity findings per review. When there is nothing to fix, say so.

## Paths to skip

`vendor/`, `schemas/vendor/`, `*.generated.ts`, lockfiles, `tests/e2e/screenshots/`
reference PNGs (screenshot review owns them) and `docs/releases/`.

## Evidence

- Give the file and line for both the trigger and the effect. Read the definition of anything
  you rely on; never infer behaviour from a name.
- When a bug is one instance of a pattern, name the pattern and every other place it occurs, so
  the author fixes the class in one round.
