# Headless automation contract

Tracking: [#1079](https://github.com/copse-dev/agent-pane/issues/1079)

Status: **Active — Phases 0–1 landed.** The canonical contract module, its
published JSON Schema, and the conformance scaffold are on the feature branch, and
the benchmark harness is wired as the contract's first conformance consumer; the
spine projection, ACP, and CLI adapters follow in later phases.

Investigation and trade-offs:
[`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md)
(§"Headless mode is a product surface") and
[`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md)
(P3 "Unify the runtime contract").

## What this is

Copse already has the pieces of a headless runtime, but no single product-level
compatibility contract owns them:

- [#264](https://github.com/copse-dev/agent-pane/issues/264) owns ACP transport
  and integration.
- [#752](https://github.com/copse-dev/agent-pane/issues/752) owns benchmarks and
  has shipped a headless harness (`npm run bench:agent`,
  `scripts/bench-agent-lib.mts`).
- [`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md)
  proposes a common runtime protocol and a future headless adapter.

ACP is a transport and the benchmark harness is a consumer/conformance oracle.
Neither should independently define Copse's canonical turn lifecycle. This plan
defines and ships **one versioned headless automation contract** that the CLI,
ACP agent server, benchmark runner, CI, and future remote-agent adapters share.

## The fragmentation this closes

An audit of the existing non-UI turn-driving code (the `@copse/agent` loop, the
thread-store spine, and the ACP service) found the same concepts encoded several
different ways, with no schema reconciling them:

1. **No canonical run request.** Only `AgentRunPayload`
   (`packages/agent/src/wire-types.ts`) exists, and it is shaped for the GUI
   (invoked skills, working brief, turn-tree epoch). "Resume" is implicit — the
   bench harness reuses a `messages` array; the ACP entry keeps history in a
   closure — and there is no first-class new/resume/fork request outside ACP's
   session lifecycle.
2. **Three tool-call / event shapes for the same data:** the runtime
   `AgentStreamChunk` / `ToolCall` (`wire-types.ts`), the persisted
   `SpineMessageLine` / `SpineToolCall` (`src/shared/threads/spine-schema.ts`),
   and ACP `SessionUpdate`, bridged only by the hand-written
   `session-update-adapter.ts`.
3. **Stop reasons and exit codes are unenumerated.** `done.stopReason` is a bare
   provider string; exit statuses are ad-hoc `process.exit(1|2)` / `124` calls.
4. **Three permission vocabularies:** hook `'allow' | 'deny' | 'ask'`, ACP
   `'allow' | 'reject' | 'cancelled'`, and ACP session modes.
5. **No schema validation on any wire boundary** — every crossing is a
   hand-rolled parser.
6. **Capability / version negotiation exists only inside ACP**
   (`AcpCapabilitySnapshot`); a native headless contract has none.

## Contract (minimum surface)

- Request schema for new, resume, and fork operations.
- Stable thread, turn, item, approval, and tool-call identifiers.
- Streaming JSONL plus human-readable output modes, with documented
  stdout/stderr separation.
- Documented exit statuses.
- Cancellation and signal behavior, including interrupted-turn resumability.
- Capability discovery and protocol version negotiation.
- Explicit non-interactive permission behavior with a deny-by-default CI profile
  — headless mode must not silently broaden permissions when interactive
  approval is unavailable.
- Replayable run artifacts compatible with the benchmark measurement contract
  (checkout / transcript / patch / verifier / model / config / feature-flag /
  attempt / stop-reason).

## What landed in Phase 0

- **Single source of truth** — `packages/agent/src/headless-contract.ts`. Authored
  as zod schemas so the TypeScript types (`z.infer`) and the published JSON Schema
  (`z.toJSONSchema`) come from one declaration. It lives in `@copse/agent`
  (Electron-free, depends only on `@copse/llm` + zod) so every adapter can import
  it without pulling in `src/main`. It defines:
  - `HEADLESS_PROTOCOL_VERSION` and `negotiateProtocolVersion()`.
  - The `Thread → Turn → Item` identifier vocabulary.
  - `headlessRunRequestSchema` — a discriminated union of `new` / `resume` /
    `fork` requests over shared fields (`cwd`, `input`, `model`, `outputMode`,
    `permissionProfile`).
  - The canonical event envelope (`headlessEventSchema`): `turn_start`,
    `message`, `reasoning`, `tool_call`, `tool_result`, `approval_request`,
    `turn_end`, each a versioned line.
  - `HeadlessOutcome` / `HeadlessStopReason` enums, `normalizeStopReason()` (folds
    provider strings into the canonical enum by reusing `@copse/llm`'s
    classifiers), and `HEADLESS_EXIT` + `exitCodeForOutcome()` (130 = SIGINT,
    124 = timeout, following shell / coreutils convention already used by the
    terminal-bench adapter).
  - The permission model: one `'allow' | 'deny' | 'ask'` decision vocabulary,
    `headlessPermissionProfileSchema`, the `CI_DENY_BY_DEFAULT_PROFILE` constant,
    and `resolveNonInteractiveDecision()` — which fails `'ask'` **closed** to
    `'deny'` when no interactive approver is attached.
  - `projectStreamChunk()` — the shared projection from the loop's native
    `AgentStreamChunk` stream onto canonical events, the piece every adapter
    (bench, ACP, CLI) needs.
  - `headlessCapabilitiesSchema` and `headlessContractJsonSchema()`.
- **Published schema** — `schemas/headless-contract.schema.json`, generated by
  `npm run gen:headless-schema` (`scripts/gen-headless-schema.mts`, `--check` for
  a CI drift guard), matching the existing `schemas/*.schema.json` convention.
- **Conformance scaffold** — `headless-contract.test.ts` exercises request
  round-trips, deny-by-default resolution, stop-reason normalization, exit-code
  coverage over every outcome the schema enumerates, event validation, the
  `projectStreamChunk` mapping, and a drift assertion that the committed JSON
  Schema equals the generated one.

## Boundaries

- **No separate daemon required.** The runtime may stay in the Electron main
  process initially; the success criterion is that the renderer and an external
  client observe the same lifecycle, not that Copse adds a process boundary for
  its own sake.
- **The thread stays authoritative for active-task state**
  ([#1068](https://github.com/copse-dev/agent-pane/pull/1068)). This contract must
  not introduce a duplicate task-memory store.
- **Provider-specific history is a projection** of the canonical lifecycle, not a
  second public contract.
- This work does not replace ACP or benchmark tracking; those projects become
  adapters and conformance consumers.

## Phased plan

- [x] **Phase 0 — canonical contract + conformance scaffold.** The source-of-truth
      module, published JSON Schema, generator, and unit-level conformance tests.
- [x] **Phase 1 — benchmark harness as first conformance consumer.**
      `scripts/bench-agent-lib.mts` now projects its loop stream through
      `projectStreamChunk` (via the exported `buildHeadlessTurnEvents` adapter
      assembly, which validates every event against `headlessEventSchema` — the
      conformance check) and writes a canonical `<task>.headless.jsonl` envelope
      beside each existing raw trace. The first real adapter proving the contract.
- [ ] **Phase 2 — spine projection.** Show the persisted `SpineMessageLine` /
      `SpineToolCall` shapes derive from (or validate against) the canonical event
      vocabulary, so the replayable artifact and the live stream share one model.
- [ ] **Phase 3 — ACP adapter conformance.** Route the ACP agent server's
      `session/new | resume | prompt | cancel | request_permission` through the
      contract's request/event/permission types, keeping ACP as a transport adapter.
- [ ] **Phase 4 — CLI surface.** A documented `copse` headless entry point that
      consumes `headlessRunRequestSchema` on stdin and emits the event envelope, with
      the deny-by-default profile as its non-interactive default.

## Acceptance-criteria mapping (from #1079)

| Criterion                                                                     | Phase                        |
| ----------------------------------------------------------------------------- | ---------------------------- |
| One source of truth generates/validates the TS and JSON schemas               | 0 ✓                          |
| Headless mode cannot silently broaden permissions without interactive input   | 0 ✓                          |
| New/resume/fork/cancel/success/failure/approval flows have documented exits   | 0 ✓                          |
| Same deterministic scenario passes through benchmark, CLI, and ACP adapters   | 1 ✓ (benchmark); CLI/ACP 3–4 |
| Conformance runs retain the replayable artifact and measurement fields        | 1 ✓; 2                       |
| Provider-specific history is a projection, not a second public contract       | 2                            |
| Desktop renderer and external clients observe equivalent turn terminal states | 3                            |
