# Hooks in Copse — architecture

This is the **architecture umbrella** for Copse's hooks platform: one registry, one
canonical event vocabulary, two executor kinds, and three on-disk dialects. It is the
landed-design counterpart to the phased plan in
[`docs/plans/hooks-and-feature-packs.md`](./plans/hooks-and-feature-packs.md) (the design
source of truth and decisions log) and the entry point to the three dialect references:

- [`docs/cursor-hooks.md`](./cursor-hooks.md) — the imported Cursor `hooks.json` dialect
- [`docs/claude-hooks.md`](./claude-hooks.md) — the imported Claude Code `settings.json` dialect
- [`docs/copse-hooks.md`](./copse-hooks.md) — Copse's own native `.copse/hooks.json` dialect

Read a dialect doc for the exact on-disk format, events, and response fields a config
author writes. Read this doc for **how the pieces fit** — where the harness fires events,
how a decision flows back, and the cross-cutting concerns (budget, spine, sandbox, UI)
that are dialect-agnostic.

> Everything below reflects what has **landed** (through the
> [validation & tooling phase](./plans/hooks-and-feature-packs.md#phase-g--validation--tooling)).
> [Feature packs](./plans/hooks-and-feature-packs.md#feature-packs) are the intended end
> state and are not implemented yet; the packs section of the plan doc describes them.
> Where behavior differs by phase, the phase tag links to the plan's issue breakdown.

## What a hook is

A hook is a function of `(canonical event) → decision` (the [unified-registry design decision](./plans/hooks-and-feature-packs.md#decisions-log)). It can **observe**,
**block**, or **annotate** the action that triggered it. Two things run hooks, and they
share one registry, one event vocabulary, and one Sources UI:

- **First-party (function) hooks** — in-process functions in `packages/agent` (Electron-free).
  They may emit typed stream chunks and read loop state, and they **fail hard**: a throw is
  a bug, loud in dev, never silently swallowed (the [vendor failure semantics decision](./plans/hooks-and-feature-packs.md#decisions-log)). These are the migrated harness
  behaviors (todo steering, closeout nudges, in-loop nudges — [the MVP milestone](./plans/hooks-and-feature-packs.md#milestone-0--mvp-todos-out-of-the-core-files)/[the first-party migration phase](./plans/hooks-and-feature-packs.md#phase-e--first-party-migration-payback-phase--not-optional)).
- **Command hooks** — user/project scripts spawned as processes, owned by a **dialect
  adapter**. They receive a JSON payload on **stdin**, may print a JSON response on
  **stdout**, and their failure semantics are the vendor's (fail-open by default, per-hook
  fail-closed honoured — the [vendor failure semantics decision](./plans/hooks-and-feature-packs.md#decisions-log)).

The **harness never knows dialects or executors exist**: it fires canonical events; the
registry dispatches to whatever is registered.

## Core pieces

```
harness  ──fires──▶  canonical event  ──▶  registry  ──▶  { function hooks | command hooks }
                                                                              │
                                              dialect adapter  ◀── source path ┘
                                              (marshal stdin / interpret stdout)
```

### Canonical events

A **canonical event** is a named point where the harness calls the registry. Names are
final (a rename is a decisions-log edit, not a refactor). The full v1 enumeration, the
kind of each event, and its fire site live in the plan's
[Canonical events table](./plans/hooks-and-feature-packs.md#canonical-events-v1-enumeration);
they are typed in `packages/agent/src/hooks/canonical-events.ts`
(`HOOK_EVENT_NAMES` / `HOOK_EVENT_SPECS` / `HookEventPayloads`). The landed set spans tool
gates (`toolGate`), lifecycle (`beforeSubmitPrompt`, `afterFileEdit`, `stop`,
`afterToolUse`), subagents (`subagentStart` / `subagentStop`), assembly points
(`turnStart`, `beforeFinalize`, `stepBoundary`), session env (`sessionStart`), and the
Copse-native events (`beforeDiffApply` / `afterDiffApply` / `permissionDecision` /
`postTurnReview`).

### Canonical decision vocabulary

Adapters translate each dialect's wire format to and from **one** normalized outcome; the
harness consumes only this shape. Blocking and async outcomes are **separate types** so an
async hook cannot return a `decision`, `updatedInput`, or `injectContext` at the type level
(the [pending-message queue](./plans/hooks-and-feature-packs.md#decisions-log) and [async injectContext](./plans/hooks-and-feature-packs.md#decisions-log) decisions are compiler errors, not review comments —
`packages/agent/src/hooks/hook-outcome.ts`, pinned by
`async-outcome-type-excludes-decisions.test.ts`):

```ts
interface HookOutcome {
  decision?: 'allow' | 'deny' | 'ask'
  haltRun?: { reason: string } // continue:false — outranks everything
  updatedInput?: Record<string, unknown> // tool gates only; re-runs policy analysis (vendor response semantics phase)
  injectContext?: string // blocking hooks only (v1); async → queued message
  agentMessage?: string // fed to the model on deny/ask
  userMessage?: string // shown to the user (hook card)
  queueMessage?: { text: string; sendNow: boolean } // the async channel
  sessionEnv?: Record<string, string> // sessionStart → later hook processes
}
```

A hook can only ever **tighten** a gate: a `deny` blocks the action, but an `allow` still
flows through Copse's normal prompting — a hook can never auto-approve something Copse
would otherwise ask about.

### Executors

- **Function executor** — runs a first-party hook in-process. Gets the richer
  `FunctionHookContext` (`emitChunk` + `loopState`). Fail-hard.
- **Command executor** — spawns a script. Gets the base `HookContext` only; command hooks
  can **never** emit feature chunks (`todo_update`, `subagent_*`), which keeps the typed
  stream first-party and transcripts trustworthy (the [two-capability-tiers decision](./plans/hooks-and-feature-packs.md#decisions-log),
  `command-hooks-cannot-emit-feature-chunks.test.ts`). The contract lives in
  `packages/agent/src/hooks/command-executor.ts`; the host runner that actually spawns is
  `src/main/services/hooks/command-hook-runner.ts`.

### Dialects and adapters (source path = format)

Dialect is determined by **source path**, not prefixes or content sniffing (the [dialect-by-source-path decision](./plans/hooks-and-feature-packs.md#decisions-log)):

| Source path                         | Dialect | Adapter                                     |
| ----------------------------------- | ------- | ------------------------------------------- |
| `~/.cursor/hooks.json` + project    | Cursor  | `src/main/services/hooks/cursor-adapter.ts` |
| `~/.claude/settings.json` + project | Claude  | `src/main/services/hooks/claude-adapter.ts` |
| `~/.copse/hooks.json` + project     | Copse   | `src/main/services/hooks/copse-adapter.ts`  |

Each adapter owns **discovery, parsing, matchers, and wire marshalling both directions**:
a Cursor hook sees Cursor's stdin shape and permission vocabulary; a Claude hook sees
Claude's `tool_name` tokens and exit-code-2 protocol; a Copse hook — being our own format
— speaks the canonical event names and decision vocabulary directly, with no translation
layer, and additionally exposes the native knobs (`async`, `onFailure`, `sandbox`,
`loop_limit`). Adapters register in `dialect-registry.ts`, so the dialect-agnostic runner
routes any dialect with no per-dialect branching. Unknown events in a foreign file are
**warned about, never silently skipped**. The shared process spawn (stdin marshalling,
stdout/stderr capture, timeout, output cap) is `src/main/services/hooks/hook-spawn.ts`.

## Dispatch: blocking vs async

Dispatch is chosen **by capability, not by origin** (the [blocking-vs-async dispatch decision](./plans/hooks-and-feature-packs.md#decisions-log)):

- **Blocking** — decision/mutation hooks (tool gates, `beforeSubmitPrompt`, mutating
  `afterFileEdit`, `subagentStart`, `beforeDiffApply`). The harness awaits them; a
  blocking-hook wait pauses the idle deadline the same way tool execution does.
- **Async (detached)** — observation hooks (`stop`, `afterToolUse`, `subagentStop`,
  `afterDiffApply`, `permissionDecision`, `postTurnReview`, `sessionStart`). They dispatch
  at the step that emitted them and are **never awaited** — not by the loop, not by other
  hooks, not by `stop` (the [detached async, no drain barrier decision](./plans/hooks-and-feature-packs.md#decisions-log)). "Stop stops agent work": abort/turn-end halts emission
  of new events but never kills or waits for in-flight hooks. Async over-cap dispatches go
  into a pending-dispatch FIFO (concurrency cap ~8/thread, then a bounded backlog); nothing
  ever waits on the FIFO (the [per-hook timeouts decision](./plans/hooks-and-feature-packs.md#decisions-log)). The dispatcher is
  `src/main/services/hooks/async-hook-dispatcher.ts`.

`afterFileEdit` is dual: blocking by default, with a **per-hook async opt-in** — expressible
only by the Copse dialect's `async: true` (Cursor/Claude have no such flag), so the opt-in
landed with the [Copse-dialect adapter](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox) + [detached async executor](./plans/hooks-and-feature-packs.md#phase-c--async-executor-output-channel-budget).

### The pending-message queue is the only async output channel

An async hook cannot inject mid-turn (the [pending-message queue decision](./plans/hooks-and-feature-packs.md#decisions-log)). Its `queueMessage` lands as a **queued
message**, consumed at idle drain, or immediately if the hook sets `sendNow` (byte-for-byte
the user's send-now semantics). An async hook's `injectContext` is converted to a queued
message (the [async injectContext → queued message decision](./plans/hooks-and-feature-packs.md#decisions-log)); Claude's `asyncRewake` (background hook waking the model mid-turn) is
**unsupported in v1** and reported as such by the adapter. A `haltRun` from an async hook is
allowed and routes through the existing abort path, hook-attributed (the [haltRun from async hooks decision](./plans/hooks-and-feature-packs.md#decisions-log)).

## Auto-continuation budget, turn tree, and epoch

A **turn tree** is everything descending from one human-originated submission (a typed
message or a human send-now/release). There is **one auto-continuation budget per turn
tree** (the [unified auto-continuation budget decision](./plans/hooks-and-feature-packs.md#decisions-log)), a single counter, hard cap default 5. It counts **machine-initiated new
model turns** only: hook send-now, `stop`/`subagentStop` follow-ups, post-turn remediation
cycles, pre-review todo attempts, and todo-closeout turns. Existing per-mechanism caps
(closeout 3, pre-review 2, remediation 2) remain as **local tighteners inside** the shared
cap.

**In-loop nudges do not count.** Truncation-continue, finalize, loop, and reasoning-runaway
nudges are mid-turn message pushes inside one `runAgentLoop` invocation, already bounded by
`maxSteps` / `DEFAULT_MAX_LLM_CALLS` and the run deadline (the [loop-nudge migration](./plans/hooks-and-feature-packs.md#phase-e--first-party-migration-payback-phase--not-optional) fires them at `stepBoundary`
**without ever consuming a `ContinuationGrant`**). Conflating the two either starves the
loop or unbounds it.

The budget is **enforced at dispatch time**: a hook-originated queued message consumes
budget when it _drains_, not when it enqueues. Exhaustion (and any hook message arriving
over-budget) flips the item to a **held** state (`autoDispatch: false`), which the drain
loop skips entirely — only an explicit human action submits it, and that human action starts
a fresh turn tree with a reset budget. A `COPSE_HOOK_DEPTH` env guard prevents
hook→Copse recursion.

The budget is pure and Electron-free so both enforcement surfaces share it
(`packages/agent/src/hooks/continuation-budget.ts`): the main process keys a
`ContinuationLedger` by branded `TurnTreeId` for the in-run tighteners; the renderer applies
the same pure functions against the per-turn-tree counter it keeps on the thread. The run
folds its in-process spend back onto the thread via a `continuation_budget` chunk, epoch-
guarded and monotonic ([first-party migration](./plans/hooks-and-feature-packs.md#phase-e--first-party-migration-payback-phase--not-optional) / [async-budget phase](./plans/hooks-and-feature-packs.md#phase-c--async-executor-output-channel-budget)), so the shared cap is enforced in both directions.

### Epoch-scoping async outputs (the [epoch-scoped async outputs decision](./plans/hooks-and-feature-packs.md#decisions-log))

Every async hook dispatch carries the id of its **emitting turn tree** (its epoch). When an
output arrives, staleness is checked against the current turn tree:

- a **stale send-now downgrades to a held queued message** (`autoDispatch: false` — no
  abort, and _not_ auto-drained at idle, or a plain enqueue would re-open the back door),
- a **stale `haltRun` is a no-op**, recorded in the spine as suppressed.

Only outputs from the _current_ turn tree may abort or auto-submit; everything stale waits
for a human. This exists because send-now aborts the active local run — a late async hook
from a completed turn must never abort or inject into a newer, unrelated human turn.

### `loop_limit` clamp divergence (Cursor unlimited vs Copse clamped)

Cursor's per-script `loop_limit` bounds how many times _that script_ may auto-continue the
agent, and Cursor allows `loop_limit: null` meaning **unlimited**. **Copse diverges here on
purpose:** human-in-the-loop is the floor, so no script may loop the agent forever.

Copse treats `loop_limit` as **tighten-only**: it may only ever lower a script's
auto-continuation ceiling below the global budget, never raise it, and `null` is not a way
to escape the human-in-the-loop floor.

**Enforcement status (honest):** the field is currently **reserved** — parsed and
validated by the Copse adapter, with the intended semantics below, but **per-script
enforcement is not yet wired** (the [per-script loop-limit wiring in the async/budget phase](./plans/hooks-and-feature-packs.md#phase-c--async-executor-output-channel-budget) owns it). Today only the **global**
auto-continuation budget (the [unified auto-continuation budget decision](./plans/hooks-and-feature-packs.md#decisions-log), cap 5 per turn tree) bounds machine turns; the pure
clamp (`clampLoopLimit` in `packages/agent/src/hooks/continuation-budget.ts`) exists and is
contract-tested, waiting for the drain-path wiring.

| `loop_limit` value          | Intended enforcement ([async/budget phase](./plans/hooks-and-feature-packs.md#phase-c--async-executor-output-channel-budget))    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| a non-negative integer `n`  | `min(n, global remaining)` — the script may contribute at most `n` machine turns, and never more than the shared budget has left |
| `null` (Cursor "unlimited") | **clamped to the global remaining, with a warning** — the "unlimited" intent is refused; the shared cap is the ceiling           |
| negative / non-integer      | ignored (parse-time warning; no field carried) — Copse dialect only                                                              |

The `null`-is-refused warning already surfaces at parse time in Settings → Customise (the
Copse adapter emits it while parsing `.copse/hooks.json`). The field and its reserved
status are documented per-dialect in
[`docs/copse-hooks.md`](./copse-hooks.md#copse-native-fields).

**Cursor also exposes `loop_limit` on disk** (a per-script option in its published hook
config, defaulting to 5 for Cursor hooks and `null` for imported Claude Code hooks), but
**Copse's Cursor adapter does not parse it** — in a `.cursor/hooks.json` the field is
dropped silently, without even the reserved-field warning the Copse adapter emits. Nothing
is unbounded by that today, because Copse holds Cursor's `stop` / `subagentStop`
follow-ups rather than auto-submitting them (see
[`docs/cursor-hooks.md`](./cursor-hooks.md#two-deliberate-divergences)), so no Cursor
script can spend the continuation budget without a human. The per-script loop-limit wiring
needs to close this on the Cursor side too, not just the Copse one.

## Spine recording (always-on)

Every hook execution writes a `hook_run` line to the thread spine (the [always-on spine recording decision](./plans/hooks-and-feature-packs.md#decisions-log)): event name,
hook id, emitting step, wall-clock duration, exit code, `parse_ok`, the normalized decision,
plus raw stdout **and stderr** as blobs. stderr matters because hook stdout is the response
channel — a script's stray debug print corrupts its own response into a fail-open `allow`,
and `parse_ok: false` next to the captured bytes is what makes that visible.

Both halves of the exchange are captured, for both executors. A command hook records the
**exact stdin bytes** it was handed (serialized once in `hook-spawn.ts` and reused for the
child write and the blob, so the record cannot drift from what the process read). A function
hook has no streams at all, so it records its **dispatch payload** plus the full text of
every channel it applied — `injectContext`, `agentMessage`, `userMessage`, `updatedInput`,
halt reason — which the compact `decision` summary otherwise only counts characters of.
Function capture is scoped to runs that acted or threw: an abstaining steering hook fires
every turn and has nothing to explain, so capturing it would multiply a thread's blob count
for no answer. Captures are bounded with a visible truncation marker, never a silent cut.
This is what the hook-card **inspector** reads back (below). Recording is
always-on and survives full thread saves (`writeThread` regenerates `events.jsonl` from
messages, so appended non-message lines must round-trip — [foundations phase](./plans/hooks-and-feature-packs.md#phase-a--foundations)). The spine also records
content-addressed **toolset fingerprints** referenced by hash from assistant lines and
`hook_run` records. The spine format is documented in
[`docs/thread-store-format.md`](./thread-store-format.md).

## Sandbox ([Copse-dialect phase](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox), macOS-only)

Hooks are trusted by declaration (the user/workspace-trust gate is the consent) but
**sandboxed by default anyway** (the [sandboxed-by-default hooks decision](./plans/hooks-and-feature-packs.md#decisions-log)). `spawnHookProcess` routes a sandboxed hook
through the same macOS-seatbelt wrapper `run_shell` uses. The only escape is the Copse
dialect's `sandbox: false`, which Sources badges **"outside sandbox"**; Cursor and Claude
hooks cannot express the escape and are always sandboxed-by-default.

**Enforcement is macOS-only.** `isProjectSandboxEnabled()` is hard-false on Linux / Windows
(and when ASRT init fails), so a "sandboxed" hook still spawns with full user authority
there — treat "sandboxed" as a _default, not a guarantee_. A **sandbox-blocked** hook is
never a silent fail-open: `applySandboxBlock` escalates to a `failed` interpretation keyed
off runner-side violation signals (never the hook's own stdout, so a hook can't forge a fake
`allow` before seatbelt kills it — issue #104), records the block on the spine
(`sandboxBlocked: true`), surfaces it in the Sources panel, and resolves it through the hook's
`onFailure` (`closed` → deny; `open` → no-opinion but still recorded).

## Enablement, trust, and security

Hooks are **off by default**, gated behind the `cursorHooksEnabled` security setting
(Developer mode → Settings → Customise → Hooks) — the same gate for all three dialects. When disabled the gate
skips discovery on the hot path; Sources still lists discovered hooks so authoring problems
are visible before enabling. User configs (`~/.cursor` / `~/.claude` / `~/.copse`) are always
honoured; **project configs require workspace trust** (#100) and are skipped for untrusted
clones. Hook processes inherit the scrubbed `envForRendererChildProcess()` env — LLM
provider keys are stripped, but **non-LLM tool tokens (e.g. `GITHUB_TOKEN`) remain** and are
readable by a hook. Enabling hooks + trusting a workspace grants that repo's hook config
arbitrary local code execution on the agent's hot path; this is the same trust boundary as
[`docs/supply-chain-security.md`](./supply-chain-security.md). See each dialect doc's
Security section for the full model.

## Hook UI: cards, Sources, and the dry-run tester

- **Hook cards ([validation & tooling phase](./plans/hooks-and-feature-packs.md#phase-g--validation--tooling)).** Hook executions, deny/ask decisions, and queued hook messages render
  as a distinct **tool-call-style card family** — right-aligned, filled with the existing
  user-message accent ("same blue", never a new hue), with a zap glyph, a status badge, and
  the hook id — clearly **not** a user message. Cards are **derived** from the always-on
  spine `hook_run` lines at fold time (`attachHookCards`), never a second source of truth
  (the [disable never breaks history decision](./plans/hooks-and-feature-packs.md#decisions-log)), so an old thread renders its hooks exactly as they ran, even for a
  now-unregistered hook. The turn-level group always starts collapsed and leads with what
  changed (or “No changes”) before the run count. Expanding it keeps passive runs collapsed
  while applied effects open individually with the effect above timing/executor metadata.
  Hook-originated turns carry an `origin` marker (`Hook · <id>
(<Event>)`); the message role stays `user` for the LLM, and a human edit shows an `edited`
  note (the [hook-card attribution decision](./plans/hooks-and-feature-packs.md#decisions-log)). The card model is `src/shared/hooks/hook-card.ts`; styling is
  `src/renderer/styles/global/hook-cards.css`. Conventions are in
  [`docs/ui-taste.md`](./ui-taste.md).
- **Hook-card inspector ([validation & tooling phase](./plans/hooks-and-feature-packs.md#phase-g--validation--tooling)).** Every card carries an **Inspect run** disclosure:
  what the hook was handed and what it returned, in full. A card summarizes an effect
  (“Added context · Injected 307 chars”); the inspector shows the 307 chars. It reads the
  execution's captured blobs on demand through the read-only `hooks:runDetail` IPC
  (`src/main/services/hooks/run-detail.ts`), lazily on first open and never re-fetched — a
  hook run is immutable once recorded, and the transcript never holds a second copy of a
  hook's output. A function hook's outcome blob is re-split into one labeled block per
  channel so injected context reads with real newlines instead of JSON escapes; a command
  hook shows `stdin` / `stdout` / `stderr`. The presentation model is pure and unit-tested
  (`src/shared/hooks/hook-run-detail.ts`). Distinct from the dry-run tester below: this shows
  what **actually ran**, the tester re-runs a hook against a synthetic payload.
- **Sources panel ([foundations phase](./plans/hooks-and-feature-packs.md#phase-a--foundations)).** Settings → Customise → Hooks lists every discovered hook across all
  three dialects, per-entry validation warnings, unsupported-event badges, the
  "outside sandbox" badge ([Copse-dialect phase](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox)), and per-hook runtime error state (first failure per session).
  Developer mode reveals this advanced panel; if hooks are already enabled it remains visible
  outside Developer mode so the execution gate can always be turned off.
- **Dry-run tester ([validation & tooling phase](./plans/hooks-and-feature-packs.md#phase-g--validation--tooling)).** Each Sources hook row has a **Test** button that runs the hook
  **once** against a _synthetic_ payload for its event and shows the raw
  `stdin` / `stdout` / `stderr` / exit code / duration plus `parse_ok` and a one-line outcome
  summary. It is **side-effect-free by construction** — it reuses only the pure seams
  (adapter marshal/interpret + `spawnHookProcess`), so it never records a spine line, never
  propagates `sessionStart` env, and **never applies the outcome**; it reproduces the live
  spawn boundary faithfully (sandboxed-by-default, macOS-only enforcement). Host module:
  `src/main/services/hooks/dry-run.ts`.

## Payload stability & schema drift tooling

- **Vendored upstream schemas + drift detector ([validation & tooling phase](./plans/hooks-and-feature-packs.md#phase-g--validation--tooling)).** Copse pins committed copies of the
  two upstream foreign-dialect config schemas under [`schemas/vendor/`](../schemas/vendor/)
  (`claude-code-settings.schema.json`, `cursor-hooks.schema.json`). They are **never fetched
  over the network** at runtime or in CI, and are **never a load gate** (a config that
  violates an upstream schema still loads). They drive (1) a **warn-level authoring lint**
  (an event the vendor recognises but Copse doesn't wire yet is distinguished from a typo)
  and (2) a **CI drift detector** (`vendor-schema-drift.test.ts`) that fails when a
  re-vendored schema adds an unaccounted event until it is wired or listed as intentionally
  unsupported (`src/shared/hooks/vendored-hook-schemas.ts`). Provenance and re-vendoring
  steps: [`schemas/vendor/README.md`](../schemas/vendor/README.md).
- **Wire payload snapshots ([validation & tooling phase](./plans/hooks-and-feature-packs.md#phase-g--validation--tooling)).** Every dialect wire **request** payload is snapshot-tested
  against a committed golden fixture
  [`src/main/services/hooks/__snapshots__/wire-payloads.json`](../src/main/services/hooks/__snapshots__/wire-payloads.json)
  by `payload-snapshots.test.ts`. The request direction is the stability contract; pre-v1
  with zero consumers we don't version payloads, so **changing a snapshot is a publish-time
  stability audit** (the [payload stability at publish decision](./plans/hooks-and-feature-packs.md#decisions-log)) — the reviewed JSON diff of the fixture _is_ the stability
  declaration. Regenerate with `UPDATE_HOOK_PAYLOAD_SNAPSHOTS=1 npm test` and review the diff.
- **Copse's own schema.** Published at
  [`schemas/copse-hooks.schema.json`](../schemas/copse-hooks.schema.json)
  (`$id: https://copse.dev/schemas/copse-hooks.schema.json`) — the only schema Copse
  authors, enumerating the canonical events and native fields.

## Module layout

The boundary is fixed (execution-guidance rule 4):

- **`packages/agent/src/hooks/`** (Electron-free): canonical events (`canonical-events.ts`),
  the registry (`hook-registry.ts`), outcome types (`hook-outcome.ts`), the command-executor
  contract (`command-executor.ts`), the pure continuation budget
  (`continuation-budget.ts` / `turn-tree.ts`), the async dispatcher policy
  (`async-dispatcher.ts`), and the first-party function hooks (`turn-start-hooks.ts`,
  `before-finalize-hooks.ts`, `step-boundary-hooks.ts`). Function hooks receive app services
  via context; they never import them.
- **`src/main/services/hooks/`** (Electron-adjacent): the dialect adapters
  (`cursor-adapter.ts`, `claude-adapter.ts`, `copse-adapter.ts`), the dialect registry
  (`dialect-registry.ts`), the process spawn (`hook-spawn.ts`), the host runner
  (`command-hook-runner.ts`), each canonical event's host orchestrator (`tool-gate.ts`,
  `before-submit-prompt.ts`, `after-file-edit.ts`, `stop.ts`, `after-tool-use.ts`,
  `subagent.ts`, `session-start.ts`, `diff-apply.ts`, `permission-decision.ts`,
  `post-turn-review.ts`), the dry-run tester (`dry-run.ts`), the hook-card inspector's read
  path (`run-detail.ts`), and the spine/drift/snapshot tests.
- **`src/renderer/`**: hook cards + held-queue UI.

## Related

- [`docs/plans/hooks-and-feature-packs.md`](./plans/hooks-and-feature-packs.md) — the design
  source of truth: decisions log, canonical-event table, phased issue breakdown, feature packs
- [`docs/cursor-hooks.md`](./cursor-hooks.md) · [`docs/claude-hooks.md`](./claude-hooks.md) ·
  [`docs/copse-hooks.md`](./copse-hooks.md) — the three dialect references
- [`docs/thread-store-format.md`](./thread-store-format.md) — spine format the `hook_run` line extends
- [`docs/supply-chain-security.md`](./supply-chain-security.md) — the trust boundary hooks live inside
- [`docs/ui-taste.md`](./ui-taste.md) — hook-card conventions
- [`schemas/vendor/README.md`](../schemas/vendor/README.md) — vendored upstream schemas ([validation & tooling phase](./plans/hooks-and-feature-packs.md#phase-g--validation--tooling))
- Cursor hooks reference: <https://cursor.com/docs/hooks> · Claude Code hooks reference:
  <https://code.claude.com/docs/en/hooks>
