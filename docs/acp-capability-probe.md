# ACP capability probe (Tier-1 eval)

`npm run probe:acp` spawns each installed [ACP](https://agentclientprotocol.com/)
agent (Claude, Codex, Cursor, Gemini, …), runs the `initialize` and
`session/new` handshake, records everything the agent negotiates, and tears it
down again — **without ever sending a prompt.** It then writes a support matrix
(Markdown + JSON) comparing the agents.

## Why this exists

The ACP spec makes almost every feature an **optional capability** or an
explicitly **unstable** extension. Whether a given agent supports session
resume, image prompts, http MCP servers, session modes, structured usage — and
what it tunnels through the reserved `_meta` field — is not knowable from the
spec. It can only be measured, per agent **and adapter version**, because
adapters change what they advertise release to release.

This probe turns that guesswork into data. It's the cheap, near-deterministic
**Tier 1** of the ACP evaluation harness:

- **Tier 1 (this):** connection-time negotiation only. No prompt, no model
  tokens, and (for well-behaved adapters) no auth required — `initialize`
  succeeds before sign-in. Runnable anywhere the agent binary is on `PATH`.
- **Tier 2 (`npm run probe:acp:behavior`, issue #832):** behavioural probes
  under one real `session/prompt` — does a file edit route through
  `fs/write_text_file` (the diff queue) or land via an `execute`/shell tool
  call? What does a `session/request_permission` payload actually carry?
  Which `_meta` keys appear mid-turn? Needs auth and spends tokens, so it is
  opt-in (same posture as `npm run test:e2e:agent-eval`).

## Running it

```sh
npm run probe:acp                 # probe every known agent found on PATH
npm run probe:acp -- --agent codex --agent cursor   # just these
npm run probe:acp -- --all        # also list not-installed agents (as failures)
npm run probe:acp -- --no-write   # print only, don't write files
npm run probe:acp -- --out ./my-matrix   # custom output basename
npm run probe:acp -- --settle 1500       # widen the post-connect update window
```

By default it writes `docs/acp-support-matrix.md` and
`docs/acp-support-matrix.json` (both git-ignored, since they're
machine/version-specific — `git add -f` if you want to commit a reference
snapshot) and echoes the matrix to the terminal.

Install agents first if the probe finds none — `npm run detect:acp` lists what's
installed and how to install the rest. The probe reuses the same
`KNOWN_ACP_AGENTS` catalog (`src/shared/acp-known-agents.ts`), so adding an agent
there makes it probeable too.

## What it records

Per agent, from `initialize` / `session/new` (plus a short best-effort drain of
updates the agent pushes on connect):

| Group    | Fields                                                                              |
| -------- | ----------------------------------------------------------------------------------- |
| Identity | protocol version, agent/adapter name + version (`agentInfo`)                        |
| Sessions | `loadSession`, `session/resume`, `list`, `delete`, `close`, `fork`†, addl. dirs     |
| Prompt   | image, audio, embedded-context content support                                      |
| MCP      | http, sse, acp† transports the agent accepts on `session/new`                       |
| Modes    | advertised session modes and the current one                                        |
| Models   | the `category: "model"` selector — count and current default                        |
| Auth     | advertised authentication methods                                                   |
| Commands | slash/available commands the agent announces on connect (best-effort)               |
| `_meta`  | verbatim `_meta` payloads on the initialize and session/new responses, and key list |
| Unstable | which non-spec capabilities the agent advertised                                    |

† Marked _unstable_ in the spec.

The **JSON snapshot keeps the full, verbatim `agentCapabilities` and `_meta`
objects**, so nothing is lost even where the Markdown matrix only shows a
count — this is the record for spotting what a vendor adapter tunnels through
`_meta`.

## How it's built

- `src/main/services/acp/acp-capability-probe.ts` — spawn + handshake +
  `extractCapabilitySnapshot` (the pure, unit-tested extraction). Unlike the
  real client (`acp-client.ts`), the probe spawns **unsandboxed** and does not
  scrub provider keys: it's safe because no prompt runs, so no model turn
  executes — it only reads negotiation.
- `src/main/services/acp/acp-support-matrix.ts` — pure Markdown + JSON
  rendering.
- `scripts/probe-acp-agents-lib.mts` / `scripts/run-probe-acp-agents.mts` — the
  runner (esbuild-bundled, mirroring `validate:local-agent`).

`acp-capability-probe.test.ts` drives the whole probe against an **in-memory
fake agent** with controllable capabilities, so the extraction is verified in CI
with no agent installed.

## Protocol version (v1 today)

The probe is a **v1 client** — it requests the SDK's `PROTOCOL_VERSION` (1) in
`initialize`, and by ACP's version negotiation every agent answers v1. The
`--protocol <n>` flag sets the requested version and the report records
requested-vs-negotiated (flagging a downgrade), which is the forward hook for
**ACP v2** — an unstable draft no shipping agent speaks yet. What v2 changes and
where it lands is tracked in [`docs/acp-v2-readiness.md`](acp-v2-readiness.md).

## Tier 2 — behavioural probe (`npm run probe:acp:behavior`)

Issue [#832](https://github.com/copse-dev/agent-pane/issues/832). After the
handshake, this probe sends one fixed `session/prompt` that asks the agent to
write a marker file (`.copse-acp-behavior-probe.txt` with content `PROBE_OK`),
auto-allows permissions, and records:

| Observation             | What it answers                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Write routing**       | Did the agent call `fs/write_text_file` (diff-queue path), emit an `execute` tool call (shell path), both, or neither? |
| **Permission payloads** | Kind, title, option ids/kinds, and `rawInput` _keys_ (values are never logged — they may contain secrets)              |
| **Mid-turn `_meta`**    | Keys on permission requests, tool updates, fs writes, and message chunks during the turn                               |

```sh
npm run probe:acp:behavior              # every installed known agent
npm run probe:acp:behavior -- --agent claude
npm run probe:acp:behavior -- --no-write
npm run probe:acp:behavior -- --timeout 180000
```

Writes `docs/acp-behavior-matrix.{md,json}` (git-ignored, same as Tier 1).

How it's built:

- `src/main/services/acp/acp-behavior-probe.ts` — prompt + observation
  (`extractBehaviorSnapshot` is pure and unit-tested).
- `src/main/services/acp/acp-behavior-matrix.ts` — Markdown + JSON rendering.
- `scripts/probe-acp-behavior-lib.mts` / `scripts/run-probe-acp-behavior.mts` —
  the runner.

CI covers the extraction against in-memory fake agents that script each write
routing and `_meta` shape — no real agent or tokens required for `npm test`.

## See also

- [`docs/acp-agents.md`](acp-agents.md) — using external ACP agents (client role).
- [`docs/acp-support-findings.md`](acp-support-findings.md) — findings from the first real probe run.
- [`docs/acp-v2-readiness.md`](acp-v2-readiness.md) — what ACP v2 changes and our migration plan.
- [`docs/plans/acp-client-support.md`](plans/acp-client-support.md) — the phased rollout.
