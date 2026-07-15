# @copse/plan-usage

Standalone client for **subscription plan usage** (Claude / Codex 5-hour and
weekly windows). Extracted as an in-repo workspace package in the same staging
shape as `@copse/llm` and `@copse/agent`: tsconfig + esbuild aliases, zero
imports from the host app, and a public surface that **never throws**.

If a provider is unsigned-in, the endpoint shape changes, or the network fails,
callers get a typed `unavailable` / `error` result and keep working. The host
app's local token ledger is unrelated and unaffected.

## What's in it

- **`fetchClaudePlanUsage`** — `GET https://api.anthropic.com/api/oauth/usage`
  (undocumented; same endpoint Claude Code `/usage` uses). Needs a Claude.ai
  OAuth token (`sk-ant-oat01-…`), not a console API key.
- **`fetchCodexPlanUsage`** — `GET …/wham/usage` (ChatGPT backend). Needs a
  ChatGPT / Codex access token (+ account id when present).
- **`getPlanUsageSnapshot`** — fan-out over both providers; always resolves to a
  `PlanUsageSnapshot` (per-provider ok / unavailable / error).
- **Credential parsers** — pure JSON parsers for `~/.claude/.credentials.json`
  and `~/.codex/auth.json` shapes (filesystem I/O stays in the host).

## Design

- **Fail-soft by default.** Public entry points catch and convert failures;
  nothing in this package should take down the Electron main process.
- **Injectable `fetch` + clock** for tests; no global mutation.
- **No host imports.** Types and helpers live entirely under `packages/plan-usage/`.
- **Undocumented endpoints.** Gated in the host behind optional UI; degrade to
  “no plan credentials” when auth or response shape breaks.

## Remaining step for a true standalone repo

Mirror `@copse/llm`: publish as its own package once the surface stabilizes.
For now the app deep-imports `@copse/plan-usage/*` via path aliases.
