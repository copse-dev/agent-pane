# Grok Build architecture comparison

Status: architecture review and follow-up proposal, 2026-07-21.

Tracking: [#1078](https://github.com/copse-dev/agent-pane/pull/1078), with follow-up
issues [#1079](https://github.com/copse-dev/agent-pane/issues/1079),
[#1080](https://github.com/copse-dev/agent-pane/issues/1080),
[#1081](https://github.com/copse-dev/agent-pane/issues/1081), and
[#1082](https://github.com/copse-dev/agent-pane/issues/1082).

This document compares Copse with the public
[`xai-org/grok-build`](https://github.com/xai-org/grok-build) repository and turns the
useful differences into owned follow-up work. It is not a request to reproduce Grok
Build wholesale. Copse is an integrated, multi-provider Electron product with a mature
desktop experience; Grok Build is a terminal-first coding agent with a particularly
broad automation and customization surface.

The Copse baseline is `main` at `d43a3ef09`, including the thread-state and evaluation
decisions from [#1068](https://github.com/copse-dev/agent-pane/pull/1068). The Grok Build
baseline is `a881e6703f46b01d8c7d4a5437683546df30449d`, inspected on 2026-07-21. The
comparison uses public code and documentation only.

## Executive decision

Keep Copse's integrated desktop architecture and adopt four ideas as explicit product
contracts:

1. a stable headless automation contract shared by CLI, ACP, benchmarks, and future
   remote-agent adapters;
2. transactional Plan Mode and prompt-boundary rewind as human-control and recovery
   primitives;
3. a complete knowledge retrieval lifecycle, not only a knowledge store and editor;
4. a general background task supervisor that long-horizon tasks, remote delegation,
   monitors, and recurring schedules can share.

Treat user-defined agents and a Copse-native plugin marketplace as separate extension
work. Extend the existing permission architecture with declarative profiles, but do not
copy Grok Build's fail-open and prefix-matching footguns.

Copse should preserve its stronger foundations: provider neutrality, readable durable
state, hooks and feature packs, per-thread worktree design, and conservative permission
routing when an OS sandbox is unavailable.

## Evidence scope

### Copse

- [`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md) already
  proposes a service-grade runtime spine, capability-aware protocol, declarative
  permission profiles, child-agent lifecycle, and a future headless adapter.
- [`industry-benchmarks.md`](industry-benchmarks.md) has delivered a deterministic
  headless benchmark harness and now specifies terminal/small-model stress lanes,
  repeated-attempt distributions, feature A/B arms, and a reproducibility contract, but
  that harness is not yet a public automation product.
- [`acp-client-support.md`](acp-client-support.md) and
  [#264](https://github.com/copse-dev/agent-pane/issues/264) cover ACP transport and
  product integration.
- [`knowledge-store.md`](knowledge-store.md) has delivered the durable store and
  migrations. #1068 establishes that active-task state remains authoritative in the
  thread and must be projected/searched there rather than copied into durable project
  knowledge. Phase 3 still needs a complete cross-task retrieval and review lifecycle.
- [`long-horizon-tasks.md`](long-horizon-tasks.md) has a durable task checklist but no
  general supervisor, wake policy, or scheduled execution.
- [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) defines a deep hook and
  feature-pack platform with explicit compatibility and safety decisions.
- [`thread-worktrees.md`](thread-worktrees.md) defines a comprehensive checkout
  lifecycle and distinguishes thread identity, checkout isolation, and recovery.
- [`cursor-plugins.md`](../cursor-plugins.md) imports external plugin ecosystems, but
  deliberately defers a Copse marketplace and installation lifecycle.
- [`command-sandboxing-routing.md`](command-sandboxing-routing.md) and the permission
  policy implement conservative command routing. Richer user/project profiles remain
  proposed in the Codex comparison.

### Grok Build

The most relevant public references are:

- [headless mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md);
- [sessions and rewind](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md);
- [memory](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/13-memory.md);
- [Plan Mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md);
- [background tasks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md);
- [subagents](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md);
- [plugins](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md);
- [permissions and safety](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md);
- [sandboxing](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md);
- [custom models and agents](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md).

## Comparative assessment

| Dimension       | Copse strength                                                                                                                  | Grok Build strength                                                                                  | Copse gap or decision                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product host    | Rich integrated Electron UI, terminals, diffs, settings, provider choice, and deterministic e2e                                 | Terminal-first CLI is easy to compose locally and in CI                                              | Define a stable non-UI input/output/exit/signal contract instead of treating the benchmark harness or ACP transport as the product contract                           |
| Sessions        | Human-readable filesystem thread store, append-only events, blobs, and strong worktree lifecycle                                | User-visible resume, fork, and prompt-boundary rewind                                                | Add a checkpoint model that restores both durable conversation state and workspace mutations with an explicit preview and failure policy                              |
| Planning        | Roadmap plans, long-task checklists, working briefs, and plan files                                                             | A distinct read-only exploration mode with a persistent plan and approval transition                 | Add a user-facing transactional Plan Mode; keep it separate from the automatic working brief and from long-horizon execution tracking                                 |
| Knowledge       | Typed cross-task OKF notes plus authoritative thread-native task state, both inspectable                                        | Automatic capture, retrieval injection, consolidation, decay/diversity, and post-compaction recovery | Keep task-state projection/search separate from curated project knowledge; specify retrieval, provenance, budgets, review, deletion, and stale-note handling for each |
| Background work | Long-task scaffold, CI experiments, subagents, remote-e2e, and planned A2A                                                      | Background commands and task controls are presented as one user model                                | Build one durable supervisor before adding monitors or schedules independently                                                                                        |
| Agents          | Provider-neutral loop, nested subagent timeline, hooks, model roles, and first-class thread direction                           | User-defined agent definitions and explicit capability modes                                         | Define agent manifests with identity, model role, instructions, capabilities, input/output contract, ownership, and resume semantics                                  |
| Extensions      | Mature hooks, feature packs, skills, MCP, browser, and compatibility imports                                                    | Discoverable install/update/uninstall plugin workflow                                                | Keep feature packs as the runtime unit, then add a signed/indexed distribution lifecycle with pinning and conflict reporting                                          |
| Permissions     | Per-segment shell routing, optional classifier that cannot grant authority, macOS enforcement, conservative no-sandbox behavior | Accessible user-facing permission and sandbox controls                                               | Add serializable project/thread profiles and explain actual platform enforcement; do not weaken the existing decision boundary                                        |

## Where Grok Build is ahead

### 1. Headless mode is a product surface

Grok Build documents a direct command-line contract rather than only using a hidden
headless path for tests. That makes automation behavior discoverable: callers can
reason about input, streaming/output formats, session continuity, tool permissions,
exit status, and interruption.

Copse has three pieces of this future surface:

- the Phase-2 benchmark harness in #752;
- ACP agent/server work in #264;
- the runtime-contract and future adapter direction in
  [`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md).

None owns the complete product contract. ACP is a transport; benchmarks are a consumer;
and an architecture direction is not an executable compatibility promise. A dedicated
tracker should define one turn lifecycle used by all of them.

Minimum contract:

- request schema for new, resume, and fork operations;
- stable streaming JSONL and human-readable output modes;
- canonical thread, turn, item, approval, and tool-call identifiers;
- documented stdout/stderr separation and exit statuses;
- cancellation and signal behavior, including whether an interrupted turn is
  resumable;
- explicit non-interactive permission behavior with a deny-by-default CI profile;
- capability discovery and protocol versioning;
- conformance tests that run the same scenario through the benchmark, CLI, and ACP
  adapters while retaining #1068's replayable artifact and measurement contract.

### 2. Planning and rewind are explicit control primitives

Copse has several kinds of plans, but none is the user-facing transaction Grok Build
is aiming at: explore without mutating, write a reviewable plan artifact, collect inline
feedback, and approve the transition to implementation.

This is different from the thread working brief in
[#35](https://github.com/copse-dev/agent-pane/issues/35), which deliberately excludes
user-facing Plan Mode, and from long-horizon tracking, which manages work after an
implementation goal is accepted.

Plan Mode should be enforced by capabilities, not prompt text:

- file mutations, mutating MCP tools, background launches, git writes, and write-capable
  child agents are unavailable while planning;
- shell access is either read-only by construction or separately approved, because
  redirection and arbitrary programs can bypass an edit-tool block;
- the plan is a durable, versioned artifact with inline comments and revision history;
- approval records the exact plan revision and chosen execution profile;
- implementation starts a new turn and links every material deviation back to the
  approved plan.

Rewind should use prompt-boundary checkpoints. Each checkpoint records the canonical
event position, checkout identity, HEAD/index/worktree state, and any recoverable
external side effects. Rewind must preview affected files and explicitly list effects
that cannot be undone. It should never imply that an API call, pushed commit, or remote
MCP mutation was reversed when only local state changed.

### 3. Knowledge and active-task state have distinct retrieval lifecycles

Copse's persistence base is stronger than Grok Build's undifferentiated memory model:
project notes are typed, readable, editable, and owned by a project namespace, while the
thread already contains authoritative short-horizon task state. #1068 makes that
boundary binding. Working briefs, todos, messages, tool evidence, failures, validation
output, and the current diff must not be copied into `Memory` notes.

The active-task lifecycle belongs to the thread/agent layer:

1. derive a compact task-state projection from canonical thread events and checkout state;
2. provide scoped search over current-thread OKF messages and tool-result blobs;
3. record only non-derivable hypotheses, dead ends, or decisions as append-only
   thread-owned annotations through the serialized store API;
4. surface the projection at turn start, resume, and immediately after compaction under a
   fixed context budget;
5. measure solve-rate and efficiency lift using #1068's repeated feature A/B arms before
   making any surfacing default.

Phase 3 of [`knowledge-store.md`](knowledge-store.md) should separately specify the
cross-task project-knowledge lifecycle:

1. **capture** — explicit `remember`, imports, and optional reviewable promotion proposals
   for facts that genuinely outlive the task;
2. **provenance** — source thread/turn, author, timestamps, confidence, and supersession;
3. **retrieval** — lexical plus semantic candidates, filtered by project/type/status;
4. **ranking** — relevance, recency, confidence, diversity/MMR, and repetition penalty;
5. **injection** — relevant project facts under a fixed budget, distinct from the
   thread-native task-state budget;
6. **consolidation** — merge or supersede duplicates without silently rewriting source
   material;
7. **review and deletion** — visible provenance, user edits, opt-out, and complete purge;
8. **evaluation** — retrieval hit rate, stale-note rate, prompt cost, and incremental
   outcome lift over thread history alone.

There is no automatic pre-compaction flush from active task state into durable project
knowledge. A fact may be promoted only through an explicit action or reviewable proposal.
Grok Build's automatic memory lifecycle remains useful inspiration for retrieval timing,
but model-generated notes must not become invisible durable authority.

### 4. Background work has one supervisor

Copse currently has several consumers that need the same missing primitive:

- the self-paced loop and CI integration in
  [#558](https://github.com/copse-dev/agent-pane/issues/558);
- durable remote tasks and delegation in
  [#1015](https://github.com/copse-dev/agent-pane/issues/1015);
- dark-factory orchestration;
- background commands, monitors, and recurring schedules.

Implementing a scheduler inside each feature would duplicate ownership, cancellation,
retry, persistence, and notification logic. A general supervisor should own:

- durable task identity and parent thread/turn/agent ownership;
- queued, running, waiting, blocked, cancelled, failed, and completed states;
- process/log handles that survive renderer closure and app restart where possible;
- cancellation, timeout, retry, concurrency, and resource policy;
- one-shot wake-at, event-driven wake, and recurring schedule triggers;
- explicit permission snapshots and re-approval rules for delayed execution;
- notification and resume semantics, including how results enter a thread;
- task history, retention, and audit data.

Long-horizon tracking remains the goal/checklist state machine; it becomes a consumer of
the supervisor rather than the scheduler itself.

## Copse advantages to preserve

### Hooks and feature packs

Copse's hook/feature-pack plan has stronger lifecycle, compatibility, observability, and
security reasoning than a simple plugin loader. Distribution should build on that unit
instead of introducing a parallel extension runtime.

### Worktree and durable-state design

Copse's thread store and per-thread worktree plan make state inspectable and recovery
behavior explicit. #1068 also makes the thread authoritative for active-task context.
Rewind and task-state surfacing should integrate with these foundations rather than
introduce a second session database, task-memory store, or hidden snapshot authority.

### Provider and credential safety

Copse treats an optional classifier as advice rather than authorization and avoids
pretending that unsupported platforms have an OS security boundary. Preserve that
honesty. A future headless mode must not receive broader defaults merely because no UI
is available to ask for approval.

### Desktop workflow

Terminal-first composability is useful, but it should not flatten Copse's strengths:
inline diffs, tool timelines, plan review, knowledge editing, task status, and permission
explanations can all be better in the desktop app. Headless and desktop should be
adapters over the same lifecycle, not lowest-common-denominator products.

## Grok Build risks not to copy

### Plan Mode bypasses

Blocking named edit tools is insufficient when shell redirection, scripts, mutating MCP
calls, or write-capable subagents remain available. Copse should enforce a planning
capability profile at the registry and runner boundaries.

### Fail-open containment

Grok Build's documentation includes environments where sandboxing is disabled by
default, platform enforcement differs, or a failed hook/sandbox path can continue.
Copse should continue to expose actual enforcement and fail closed whenever a requested
security property cannot be provided.

### Prefix and command-chain permission rules

String-prefix allow rules are convenient but can over-authorize overloaded commands,
shell chains, and arguments with external effects. Copse's per-segment analysis is a
better foundation. Declarative profiles should describe capabilities and scoped
resources, not only remembered command prefixes.

### Invisible memory authority

Automatic memory capture and consolidation can turn a model's inference into persistent
fact, amplify stale guidance, and make deletion unclear. Provenance and user review are
part of the feature, not optional UI polish.

### Extension supply-chain ambiguity

A marketplace adds signing, provenance, dependency, update, rollback, and conflict
requirements. Installing code is not equivalent to importing declarative settings.
Feature-pack capability declarations and permission review must remain authoritative.

## Ownership map

| Capability                          | Existing owner                                                                                                                                                                                | Follow-up decision                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless runtime substrate          | [#264](https://github.com/copse-dev/agent-pane/issues/264), [#752](https://github.com/copse-dev/agent-pane/issues/752), and the Codex architecture comparison                                 | Product contract is tracked in [#1079](https://github.com/copse-dev/agent-pane/issues/1079); keep ACP and benchmarks as adapters/consumers                                                                     |
| Transactional Plan Mode and rewind  | Working brief [#35](https://github.com/copse-dev/agent-pane/issues/35), thread store, and per-thread worktrees [#869](https://github.com/copse-dev/agent-pane/issues/869) provide foundations | Design and implementation are tracked in [#1080](https://github.com/copse-dev/agent-pane/issues/1080) and [`plan-mode-and-rewind.md`](plan-mode-and-rewind.md)                                                 |
| Knowledge retrieval lifecycle       | [#645](https://github.com/copse-dev/agent-pane/issues/645) and [#1068](https://github.com/copse-dev/agent-pane/pull/1068)                                                                     | Expand Phase 3 on the existing issue while keeping active-task projection/search in the thread layer                                                                                                           |
| Background supervisor and schedules | Long-horizon [#558](https://github.com/copse-dev/agent-pane/issues/558), A2A [#1015](https://github.com/copse-dev/agent-pane/issues/1015), and dark-factory planning                          | Shared infrastructure is tracked in [#1081](https://github.com/copse-dev/agent-pane/issues/1081) and [`background-supervisor.md`](background-supervisor.md); make these features consumers                     |
| User-defined agent manifests        | Subagent/runtime direction, model roles, working briefs, and A2A                                                                                                                              | Keep as a named follow-up until the runtime contract and task supervisor settle                                                                                                                                |
| Plugin distribution                 | Hooks/feature packs and [`cursor-plugins.md`](../cursor-plugins.md)                                                                                                                           | Copse-native distribution is tracked in [#1082](https://github.com/copse-dev/agent-pane/issues/1082) and [`feature-pack-marketplace.md`](feature-pack-marketplace.md); reuse feature packs as the runtime unit |
| Declarative permission profiles     | Permission policy and Phase P4 of the Codex architecture comparison                                                                                                                           | Refine after the permission audit-trail work; do not create a parallel authorization engine                                                                                                                    |

## Recommended sequence

1. Define the headless/runtime contract and use the benchmark harness as its first
   conformance consumer.
2. Design Plan Mode and rewind against the canonical thread store and worktree lifecycle
   before adding UI controls.
3. Expand knowledge Phase 3 while keeping active-task projection thread-native; ship both
   retrieval paths behind measurable budgets, provenance, and #1068's A/B evidence gate.
4. Build the background supervisor, then migrate long-horizon/CI and A2A consumers onto
   it before adding recurring schedules.
5. Specify agent manifests and plugin distribution on top of the common capability,
   permission, and lifecycle contracts.

The first three are independently useful. The ordering constraints are architectural:
automation should not invent a second runtime, rewind should not invent a second durable
history, and delayed tasks should not invent a second permission model.
