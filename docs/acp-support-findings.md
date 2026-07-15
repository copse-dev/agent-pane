# ACP support findings (first real probe run)

A snapshot of what `npm run probe:acp` found against real agents, recorded here
because the generated `docs/acp-support-matrix.{md,json}` is git-ignored and
machine-specific. This is a **point-in-time reading** — re-run the probe to
refresh it.

- Probed: 2026-07-12, macOS (darwin 25.5.0)
- Adapters: `claude-agent-acp` **0.53.0**, `codex-acp` **1.1.0**, `cursor-agent acp` (no version reported)
- All three negotiated **protocol v1**.

## Stable capability matrix

Everything below reproduced identically across runs. (The only value that jittered
between runs was the slash-command count — see [caveat](#caveat-slash-command-counts-are-a-race).)

| Capability                | Claude | Cursor | Codex |
| ------------------------- | ------ | ------ | ----- |
| Session load              | ✓      | ✓      | ✓     |
| session/resume            | ✓      | ·      | ✓     |
| session/list              | ✓      | ✓      | ✓     |
| session/delete            | ✓      | ·      | ✓     |
| session/close             | ✓      | ·      | ✓     |
| session/fork _(unstable)_ | ✓      | ·      | ·     |
| additionalDirectories     | ✓      | ·      | ✓     |
| Prompt: image             | ✓      | ✓      | ✓     |
| Prompt: audio             | ·      | ·      | ·     |
| Prompt: embedded ctx      | ✓      | ·      | ✓     |
| MCP http                  | ✓      | ✓      | ✓     |
| MCP sse                   | ✓      | ✓      | ·     |
| MCP acp _(unstable)_      | ·      | ·      | ·     |
| Session modes             | 6      | 3      | 3     |
| Models                    | 5      | 33     | 5     |
| Auth methods              | 0      | 1      | 2     |
| `_meta` at handshake      | ·      | ·      | ·     |

- **Claude modes:** auto, default, acceptEdits, plan, dontAsk, bypassPermissions
- **Codex modes:** read-only, agent, agent-full-access
- **Cursor modes:** agent, plan, ask
- **Auth:** Claude none (ambient login / env); Cursor `cursor_login`; Codex `api-key` + `chat-gpt`

## What the data says

1. **The Claude ACP adapter is rich.** `claude-agent-acp` (Anthropic's own
   adapter, wrapping the Claude Agent SDK) advertises session load + resume +
   list + delete + close + **fork** + additionalDirectories + embedded context +
   image + http/sse MCP. The Agent SDK's session model is reachable **through
   ACP** — so several things first assumed to need a direct SDK backend are
   already exposed. See [acp-v2-readiness.md](acp-v2-readiness.md) and the
   decision note below.
2. **`_meta` is empty at the handshake for all three.** The earlier hypothesis
   that adapters tunnel extensions through `_meta` does not hold at
   initialize/session-new. Everything is in the typed fields. (Mid-turn `_meta`
   is unmeasured — that's Tier 2.)
3. **Session modes are alive and heavily used** — including permission/safety
   modes (Claude `acceptEdits`/`plan`/`bypassPermissions`, Codex
   `read-only`/`agent-full-access`). ACP surfaces these natively. Note this makes
   the **v2 migration behavioral**, since v2 removes modes in favor of session
   config options.
4. **Cursor is the weak ACP citizen** — only legacy `loadSession` (no
   resume/list/delete/close/fork), no `agentInfo`, no embedded context — but 33
   models. Expect fewer session features if you support it.
5. **MCP http is universal** → the native-tool bridge (which requires http)
   works for all three agents. sse: Claude + Cursor only; acp: none.

## Impact on the "SDK vs ACP" question

The capability pillar of the case for a separate Claude Agent SDK backend
**collapses**: on advertised capability the Claude ACP adapter ≈ the direct SDK
(resume, fork, modes, images all present). The remaining genuine SDK-only
advantages are all **behavioral / enforcement**, none of which Tier 1 can see:

1. `canUseTool` with full structured input vs. ACP's permission title/subject,
2. hook-based containment of shell writes into the diff queue,
3. in-process tool injection.

Those are exactly what **Tier 2** (behavioral probes,
[#832](https://github.com/copse-dev/agent-pane/issues/832)) measures. So the
decision is now: build a Claude SDK backend only if those three enforcement gaps
matter — and Tier 2 is what turns that from inference into evidence.

## Actionable Copse gaps the matrix exposed

These are "ACP already supports it, we don't use it" gaps, independent of the
big decision:

- **Use ACP `session/load`/`resume` for warm sessions** instead of the 10-minute
  reap + replay-preamble hack — Claude and Codex both advertise it.
  ([#830](https://github.com/copse-dev/agent-pane/issues/830))
- **Forward image content blocks** to agents advertising `prompt.image` — all
  three do; we currently drop attachments before prompting.
  ([#831](https://github.com/copse-dev/agent-pane/issues/831))

The behavioural follow-up (Tier 2) is tracked in
[#832](https://github.com/copse-dev/agent-pane/issues/832) and implemented as
`npm run probe:acp:behavior` — see
[`docs/acp-capability-probe.md`](acp-capability-probe.md#tier-2--behavioural-probe-npm-run-probeacpbehavior).
Run it against real signed-in agents to fill `docs/acp-behavior-matrix.md`
(git-ignored); CI covers the extraction with in-memory fake agents.

## Caveat: slash-command counts are a race

The slash-command count is **not** a stable capability. Agents register commands
asynchronously (Codex, one MCP server at a time), so a fixed settle window
samples whatever has arrived — one run saw 47 Codex commands, another 23 (the
`$github:*` and `$openai-templates:*` groups hadn't loaded yet). The matrix marks
this `≥N`; widen `--settle <ms>` for a fuller sample. Everything else is
deterministic.

## See also

- [`docs/acp-capability-probe.md`](acp-capability-probe.md) — the probe (Tier 1).
- [`docs/acp-v2-readiness.md`](acp-v2-readiness.md) — v2 landscape.
