# Headless runtime contract

Tracking: [#1079](https://github.com/copse-dev/agent-pane/issues/1079)

**Status: Proposed.** This is the first delivery slice for #1079: nail the product
contract before adding a CLI binary, ACP transport parity work, or new harness hosts.
Implementation PRs should link here and keep ACP (#264) and benchmarks (#752) as
**adapters/consumers**, not alternate runtimes.

Parent investigation: [`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md).
Related runtime/security model: [`execution-runtime-security.md`](execution-runtime-security.md)
(P4 profiles and OS boundaries). Protocol direction from
[`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md) P3/P5 remains
binding where it does not conflict with #1068.

## Why this plan exists

Copse already runs agent turns outside the interactive chat box in several places:

| Surface                 | Role today                                                            | Gap versus a product contract                             |
| ----------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| `npm run bench:agent`   | Headless loop host for plumbing evals (`scripts/bench-agent-lib.mts`) | Task-file driven; not a documented caller API             |
| ACP agent/server (#264) | Transport + permissions for external agents                           | Does not own turn lifecycle product semantics             |
| Electron main / IPC     | Primary product host                                                  | Desktop-shaped; not reusable by CI without the app        |
| Mock LLM + e2e          | Deterministic desktop and component tests                             | Not an external automation surface                        |
| Remote / managed agents | Provider-owned sessions                                               | Different lifecycle; must not fork a second Copse runtime |

#1078's ownership map says the missing piece is one **turn lifecycle** used by all of
them. This plan defines that contract and the smallest conformance path.

## Binding decisions (do not reopen lightly)

1. **One runtime, many adapters.** CLI, ACP, `bench:agent`, and future remote-agent
   hosts adapt to one Thread/Turn/Item lifecycle. They must not invent parallel agent
   loops, permission engines, or event stores.
2. **Thread store stays authoritative for active-task state** (#1068). Headless runs
   write the same spine/OKF artifacts as desktop turns. No parallel "automation memory."
3. **Deny-by-default non-interactive permissions.** A CI/headless profile must not
   gain broader defaults merely because no UI is attached. Approvals that cannot be
   satisfied non-interactively fail closed with a stable exit status.
4. **#1068 measurement contract.** Conformance and benchmark consumers keep replayable
   artifacts and one-variable A/B evidence gates; headless is not a second grading path.
5. **Security properties stay separate** (`execution-runtime-security.md`). The headless
   contract names which profile is active; it does not collapse filesystem, network,
   process, and credential mediation into a boolean `sandboxed`.

## Minimum contract

### Request surface

Callers must be able to express:

| Operation | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `new`     | Create or select a project + thread and start a turn from a prompt  |
| `resume`  | Continue an existing thread from its canonical event position       |
| `fork`    | Start a new thread/turn linked to a prior thread or turn identifier |

Each request names: protocol version, project identity, thread identity (or create),
model/provider selection (or "project default"), permission profile id, and whether
streaming is JSONL or human-readable.

### Identifiers

Stable, documented identifiers for:

- thread
- turn
- timeline/item (assistant text, tool call, tool result, approval, error)
- approval request / decision
- tool call

These must round-trip through the thread store and appear in streaming output so
adapters and conformance tests can correlate events without scraping prose.

### Streaming and stdio

- **JSONL mode:** one event per line on stdout; structured fields only.
- **Human mode:** progress on stderr or a clearly documented channel; final summary on
  stdout.
- Document which streams may interleave, and that tools/tests must not parse human mode.
- Provider secrets and raw approval prompts never appear on stdout.

### Exit status

Reserve distinct, documented codes for at least:

| Class                               | Example                                         |
| ----------------------------------- | ----------------------------------------------- |
| Success                             | Turn completed with assistant final             |
| Usage / contract error              | Bad request, unknown protocol version           |
| Permission denied (non-interactive) | Approval required under deny-by-default profile |
| Cancelled / signal                  | SIGINT/SIGTERM; document resume eligibility     |
| Internal / infrastructure           | Store I/O, provider transport failure           |

Do not overload "1" for every failure mode once a CLI exists.

### Cancellation

- Document signal handling and whether an interrupted turn is resumable.
- Cancellation must finalize or checkpoint through the same store APIs as desktop Stop,
  never orphan running tools without a terminal item.

### Capability discovery

- A versioned `capabilities` / protocol handshake lists supported operations, permission
  profiles, output modes, and adapter names.
- Unknown protocol versions fail closed (usage error), not silent downgrade.

### Permission behavior (non-interactive)

- Default CI profile: deny interactive prompts; only pre-granted profile rules run.
- macOS seatbelt / no-sandbox matrix from `permission-policy.ts` still applies; headless
  must not invent a second decision table.
- When a prompt would be required and no non-interactive grant exists, emit a structured
  approval-needed event and exit with the permission-denied status.

## First delivery slice (this PR's scope)

Ship **design-only** artifacts that unblock implementation without choosing a CLI UX:

1. This plan (contract + phases + exit gates).
2. Index entry in [`README.md`](README.md).
3. Explicit adapter ownership: #752 harness and #264 ACP consume the contract; they do
   not define competing lifecycles.

Out of scope for the first slice: CLI binary, Electron headless flag, new IPC protocol
codegen, and UI for permission profiles.

## Later phases

### H1 — Protocol sketch + fixtures

- Draft JSON Schema (or equivalent) for request, stream events, and result envelopes.
- Golden fixtures checked into `tests/fixtures/` (or `benchmarks/fixtures/`) that both a
  future CLI adapter and `bench:agent` can load.
- Exit gate: fixtures validate; no runtime host required.

### H2 — Shared turn runner seam

- Extract/adapt a host-agnostic "run one turn against a thread root" entry used by
  `bench:agent` and callable from tests without Electron BrowserWindow.
- Wire deny-by-default profile selection at the seam.
- Exit gate: `npm run bench:agent -- --mock` still passes; a new unit/conformance test
  drives the same seam with a fixture prompt and asserts JSONL-shaped events + store
  spine appends.

### H3 — ACP and CLI adapters

- ACP (#264) maps session RPCs onto the same turn seam.
- Optional thin CLI (or `node` bin) implements `new` / `resume` against H2.
- Exit gate: one conformance scenario runs through bench mock, CLI/JSONL, and ACP
  adapter with identical canonical thread events (modulo transport envelopes).

### H4 — CI permission profile + docs

- Document the deny-by-default profile and how to grant narrow exceptions for trusted CI.
- Pair with `execution-runtime-security.md` profile work; do not fork policy.
- Exit gate: a CI job runs a mock turn under the profile and fails closed on a deliberate
  approval-required tool.

## Non-goals

- Replacing the desktop app as the primary product surface.
- A second durable history or "automation-only" thread format.
- Fail-open permission shortcuts for headless convenience.
- Ranking models; benchmarks remain plumbing evals (#752).

## Open questions (resolve in H1/H2 PRs)

1. Is the first public bin a standalone `copse` CLI, a `node` script under `scripts/`, or
   ACP-only until the schema stabilizes?
2. Do fork semantics always create a new thread directory, or can they share a worktree
   with copy-on-write checkout identity (#869)?
3. Should human-readable mode be deferred until JSONL + conformance exist?

## References

- [#1079](https://github.com/copse-dev/agent-pane/issues/1079) — product tracker
- [#1078](https://github.com/copse-dev/agent-pane/pull/1078) — Grok Build comparison
- [#1068](https://github.com/copse-dev/agent-pane/pull/1068) — thread-state eval strategy
- [#752](https://github.com/copse-dev/agent-pane/issues/752) — industry benchmarks / harness
- [#264](https://github.com/copse-dev/agent-pane/issues/264) — ACP client/server
- [`scripts/bench-agent-lib.mts`](../../scripts/bench-agent-lib.mts) — current headless host
