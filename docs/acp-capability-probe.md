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
- **Tier 2 (follow-up):** behavioural probes under real turns — does a file edit
  route through `fs/write_text_file` (the diff queue) or land via the agent's
  shell? What does a `session/request_permission` payload actually carry? Which
  `_meta` keys appear mid-turn? Those need auth and spend tokens, so they'll run
  opt-in like `npm run test:e2e:agent-eval`.

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

## See also

- [`docs/acp-agents.md`](acp-agents.md) — using external ACP agents (client role).
- [`docs/acp-v2-readiness.md`](acp-v2-readiness.md) — what ACP v2 changes and our migration plan.
- [`docs/plans/acp-client-support.md`](plans/acp-client-support.md) — the phased rollout.
