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
  (undocumented; same endpoint Claude Code `/usage` uses). Prefers the structured
  `limits[]` array (`session` / `weekly_all` / `weekly_scoped`) so model-scoped
  weekly caps — Opus, Sonnet, **Fable**, future models — are auto-detected from
  `scope.model.display_name`. Falls back to legacy flat keys (`five_hour`,
  `seven_day`, `seven_day_opus`, …) when `limits[]` is absent. Needs a Claude.ai
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

## Schema probe CLI

```bash
npm run probe:plan-usage                  # live Claude + Codex (needs local CLI login)
npm run probe:plan-usage -- --provider claude --raw
npm run probe:plan-usage -- --fixture ./sample.json --provider claude
```

The probe drives the real fetch/parse path, then diffs the raw JSON against
`CLAUDE_USAGE_SCHEMA` / `CODEX_USAGE_SCHEMA`. Unknown keys or `limits[].kind`
values exit `1` so new fields (like Fable) fail loudly instead of being ignored.

## Remaining step for a true standalone repo

Mirror `@copse/llm`: publish as its own package once the surface stabilizes.
For now the app deep-imports `@copse/plan-usage/*` via path aliases.
