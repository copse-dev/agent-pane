# Codex OSS architecture comparison

Status: architecture review and implementation proposal, 2026-07-19.

Implementation ownership for the cross-target sandbox, network, credential, lifecycle,
checkpoint, and audit work now lives in
[`execution-runtime-security.md`](execution-runtime-security.md). This document remains
the comparative evidence and broader runtime-spine proposal; where sequencing overlaps,
the Copse-native execution-runtime plan is authoritative.

This document compares Copse with the public OpenAI Codex repositories and turns the
comparison into a set of implementation decisions. It is deliberately not a feature
scorecard. Copse is an integrated, multi-provider Electron product; Codex OSS is a
layered agent runtime and a collection of deployment adapters. The useful question is
which runtime properties Copse should adopt without giving up the product qualities
that make it distinct.

The Copse baseline is `main` at `6e5ee91e`, including the initial trusted
`ThreadExecutionContext` from #1029. The Codex sources were inspected on 2026-07-19.
This review covers the public repositories, not the architecture of proprietary Codex
desktop or cloud services.

## Executive decision

Keep Copse's integrated desktop architecture and provider-neutral agent loop, but put a
service-grade runtime spine underneath it. In practical terms:

1. finish making thread identity, execution root, and mutable run state explicit;
2. make one versioned event model the canonical conversation record;
3. expose the agent runtime through a generated, capability-aware protocol shared by
   Electron IPC and ACP;
4. separate permission policy from enforceable process and filesystem isolation on
   every supported platform;
5. preserve Copse's human-readable thread store, provider choice, hooks, SSH workflow,
   and rich desktop UI.

Codex OSS provides strong reference designs for the runtime boundary, thread lifecycle,
approval protocol, generated schemas, and containment layers. It is not a template to
copy wholesale: its Rust service topology, OpenAI-specific provider integration, and
rollout/state layout solve a different product problem.

## Evidence scope

### Copse

- `src/main/services/agent-service.ts` owns the in-process orchestration around the
  provider-neutral loop in `packages/agent/src/run-agent-loop.ts`.
- `src/main/services/tool-registry.ts` validates tool arguments and routes permission
  decisions before execution.
- `src/main/services/thread-execution-context.ts` now validates persisted project and
  thread identity and binds a trusted context for the complete agent turn. Its current
  implementation intentionally resolves `root === projectRoot` and
  `checkoutMode === 'shared'`.
- `src/main/services/workspace.ts` still exposes renderer-selected process-global
  workspace state alongside the newer project-id resolver.
- `docs/thread-store-format.md` defines the filesystem-native thread store: append-only
  events, readable message files, metadata, and blobs.
- `src/main/index.ts` also persists provider-format history under
  `llm-history:<threadId>`, so resumability currently has two state representations.
- `src/main/services/acp/acp-agent-server.ts` is a thin external agent boundary, while
  Electron IPC reaches the in-process runtime more directly.
- `src/main/services/security/permission-policy.ts` correctly treats a classifier as
  advice, not an authorization boundary, and recognizes that OS containment differs by
  platform.

### Codex OSS

The relevant public projects are:

- [`openai/codex`](https://github.com/openai/codex): Rust CLI and core runtime,
  `app-server`, TypeScript SDK, protocol schemas, state, tools, approvals, and sandbox
  integrations.
- [`openai/codex-action`](https://github.com/openai/codex-action): a GitHub Actions
  adapter with an API proxy, permission profiles, and process-level hardening.
- [`openai/codex-universal`](https://github.com/openai/codex-universal): a reproducible
  execution image with configurable language runtimes.

The most informative design references are the
[`app-server` protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
the [TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md),
the [Linux sandbox](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md),
the [permission-profile schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json),
and the [Action security model](https://github.com/openai/codex-action/blob/main/docs/security.md).

## Architectural comparison

| Dimension          | Copse today                                                                                                                                                                                                              | Codex OSS                                                                                                                                                                                                                                       | Direction for Copse                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product topology   | One Electron application; main process talks directly to several LLM providers and hosts the loop, tools, persistence, permissions, and UI IPC.                                                                          | Rust runtime and CLI form a reusable core. `app-server`, SDK, Action, and universal image are separate adapters around it.                                                                                                                      | Keep one installable product, but define a runtime boundary that is independent of Electron transports.                                                                    |
| Runtime contract   | Internal TypeScript calls and Electron IPC are primary. ACP exposes a smaller, separate surface.                                                                                                                         | Bidirectional JSON-RPC-like protocol over JSONL, with experimental WebSocket and Unix-socket transports; generated TypeScript and JSON Schema artifacts.                                                                                        | One typed protocol and event vocabulary, adapted to Electron IPC and ACP. Generate schemas and clients from the contract.                                                  |
| Conversation model | UI `Thread`, filesystem events/messages, provider-format history, agent-loop messages, and subagent snapshots overlap.                                                                                                   | `Thread -> Turn -> Item` is the canonical public lifecycle, with explicit start, resume, fork, archive, delete, read, and pagination operations.                                                                                                | Introduce a versioned canonical event model and make provider history a rebuildable projection.                                                                            |
| Persistence        | Human-readable OKF-style message files plus append-only `events.jsonl`, blobs, metadata, and a rebuildable catalog. Provider history is persisted separately in Electron storage.                                        | Durable JSONL rollouts plus state projections; server APIs expose lifecycle and can scan or repair metadata.                                                                                                                                    | Preserve the readable store. Remove dual authority and add versioned migrations, recovery checks, and projection rebuilds.                                                 |
| Execution context  | Trusted `projectId` and `threadId` now bind an async context, but all runs still use the shared project root. Several tools, IPC handlers, terminals, and services remain rooted through global or active-project state. | Thread and turn requests carry explicit cwd, runtime workspace roots, environment, model, and permission configuration. Isolation is supplied by the selected runtime environment rather than implied by thread identity.                       | Complete context routing before enabling worktrees. Never accept an authoritative root from the renderer. Do not claim a worktree alone is a security boundary.            |
| Subagents          | Nested subagent events and UI timelines are optimized for an integrated parent run. Lifecycle and resumption are comparatively parent-centric.                                                                           | Spawned work is represented as first-class threads with parent and ancestor relationships and normal thread lifecycle operations.                                                                                                               | Keep compact nested presentation, but give independently useful agents stable identities, ownership, cancellation, and resumability.                                       |
| Providers          | OpenAI, Anthropic, OpenRouter, LM Studio/local, and compatible providers share a provider-neutral stream interface.                                                                                                      | The public runtime is primarily designed around OpenAI model behavior and APIs.                                                                                                                                                                 | Preserve provider neutrality as a product advantage. Keep provider details behind capability negotiation and projections.                                                  |
| Safety             | Static shell analysis, approval gates, optional classifier, macOS ASRT containment, and explicit conservative behavior where no OS sandbox exists.                                                                       | Granular permission profiles plus platform containment. Linux uses bubblewrap namespaces, read-only root/binds, seccomp, and optional managed networking. The Action also reduces process privilege and protects the API credential separately. | Retain the conservative policy model, then add enforceable Linux and Windows containment and separate process privilege, network mediation, secrets, and command approval. |
| Extensibility      | Built-in/MCP tools, hooks compatible with multiple agent ecosystems, feature packs, skills, browser, semantic search, SSH workspaces, terminals, and desktop settings.                                                   | MCP, skills, apps/plugins, dynamic tools, server requests, config profiles, and generated protocol capabilities.                                                                                                                                | Keep the richer integrated UX. Make every extension declare capabilities, trust, lifecycle, and availability through the common runtime contract.                          |
| Headless and CI    | Desktop is the primary host; mock providers and Electron e2e support deterministic tests. ACP is not yet a full product-equivalent headless host.                                                                        | CLI, SDK, Action, and universal image make the same runtime usable locally, in editors, and in CI.                                                                                                                                              | Add a headless adapter only after the runtime contract is stable; pair it with a reproducible image and narrow permission profiles.                                        |

## Deep dive

### 1. Runtime boundary and protocol

Copse's shortest path from the UI to an agent turn is an advantage for product
iteration. It is also why renderer concepts, main-process storage, provider history,
tool execution, and agent lifecycle are easy to couple accidentally. ACP does not yet
cover the same lifecycle or capability surface, so it is an additional boundary rather
than the boundary.

Codex `app-server` takes the opposite approach. A client starts or resumes a thread,
starts a turn, receives typed item and turn notifications, and answers server-initiated
approval or user-input requests. Transport framing, bounded queues, schema generation,
and lifecycle events are runtime concerns rather than UI conventions.

Copse should adopt the contract properties, not necessarily a separate daemon on day
one:

- explicit protocol version and capability negotiation;
- stable thread, turn, item, tool-call, approval, and terminal identifiers;
- client requests separated from server notifications and server-initiated requests;
- generated TypeScript types and JSON Schema from one source;
- bounded event queues and documented cancellation/backpressure behavior;
- transport adapters for in-process Electron IPC and ACP over stdio.

This can initially remain in the Electron main process. The success criterion is that
the renderer and an external client observe the same lifecycle, not that Copse adds a
process boundary for its own sake.

### 2. Canonical state and provider history

Copse's filesystem-native store is more inspectable than an opaque provider transcript:
users can read messages as Markdown, events are append-only, blobs are content-addressed,
and derived catalogs can be rebuilt. That design should be preserved.

The problem is dual authority. The thread store represents the user-visible history,
while `llm-history:<threadId>` preserves provider-format messages needed to resume the
model. Edits, compaction, tool-result normalization, crash recovery, import/export, and
provider switching can cause those representations to disagree.

Define one versioned event spine as authoritative. A minimal vocabulary should cover:

- thread lifecycle and metadata changes;
- turn start, terminal state, cancellation, and failure;
- user, assistant, reasoning-summary, and system-visible items;
- tool calls, arguments, results, approvals, and attachments;
- compaction or summary boundaries with provenance;
- parent/child agent relationships.

Provider messages then become a cache or projection with a recorded provider/model and
projection version. On a cache miss, version mismatch, or integrity failure, rebuild
them from canonical events. This retains provider-specific fidelity without making
provider wire formats part of durable product truth.

### 3. Thread context and checkout isolation

#1029 landed the correct first boundary: main-process code resolves project and thread
identity from persisted state, refuses mismatched membership, and binds the result with
`AsyncLocalStorage` for the complete agent turn. It intentionally does not implement
worktree allocation or root routing yet.

The remaining work in `docs/plans/thread-worktrees.md` should be treated as a safety
prerequisite, not just a worktree feature:

1. audit every `getWorkspaceRoot()` and active-project dependency;
2. route file, shell, git, diff, backup, hook, todo, and model state through the trusted
   thread/turn context;
3. pass identity explicitly across IPC, terminal, background-process, cleanup, and ACP
   boundaries where async context cannot be assumed;
4. prove two concurrent shared-root threads cannot attribute mutable state to one
   another;
5. only then allocate and retire linked worktrees.

Codex is useful here because it treats cwd, environment, writable roots, and permission
profile as explicit runtime inputs. It does not justify claiming that Codex inherently
creates a worktree per thread. Copse's worktree design can be stronger for its desktop
workflow, provided the documentation distinguishes:

- **identity isolation**: state is owned by the correct thread and turn;
- **checkout isolation**: threads do not share files, HEAD, or index;
- **security isolation**: OS enforcement constrains filesystem, process, and network
  access.

Those are different guarantees and should have separate tests and UI language.

### 4. Permission policy versus enforcement

Copse already has an important invariant: an optional model classifier never grants
authority. Static analysis determines whether a command is contained, ambiguous, or
external; macOS can then rely on seatbelt enforcement, while platforms without a real
boundary prompt conservatively.

Codex OSS shows how to extend this into a fuller stack:

1. **Declarative profile**: allowed/denied filesystem roots, network policy, and default
   tool permissions.
2. **Approval protocol**: a request tied to the exact thread, turn, and item, including
   the proposed operation and selected scope.
3. **Command sandbox**: platform enforcement such as macOS seatbelt or Linux bubblewrap,
   namespaces, read-only binds, and seccomp.
4. **Process hardening**: run unprivileged, remove escalation paths, and constrain the
   host process independently of command classification.
5. **Secret mediation**: proxy API access so an untrusted child command never receives
   the provider credential.

Copse should add a serializable permission profile to `ThreadExecutionContext`, derived
from trusted project settings and user choices. The policy decision should remain pure
and testable. Platform runners should report their actual enforcement capabilities, and
the UI should avoid presenting equivalent safety language when those capabilities
differ.

### 5. Extensions and agent graphs

Copse's hooks and feature packs make desktop behaviors visible and configurable in a
way a protocol-first runtime often does not. Codex's advantage is that extensions and
spawned agents participate in a common lifecycle and capability model.

The convergence point should be a runtime capability registry. Each built-in tool, MCP
server, hook pack, skill, browser, or external agent reports:

- stable identity and schema version;
- availability and configuration requirements;
- permission and trust requirements;
- whether it can stream, cancel, resume, or run concurrently;
- the lifecycle events it emits.

For subagents, promote a child to a first-class thread when it can outlive a single
parent tool call or benefit from resume, archive, inspection, or independent approval.
Keep the current nested timeline as a projection for the parent UI. This avoids forcing
all small delegated work into top-level product clutter while removing the lifecycle
ceiling for substantial agents.

### 6. Execution environments and CI

`codex-action` and `codex-universal` separate three concerns that are still mostly
co-located in Copse: the agent runtime, the security wrapper, and the environment image.
That separation is valuable for remote e2e, headless automation, and future cloud or
CI execution.

After the protocol and permission profile stabilize, Copse can add a headless adapter
that consumes the same requests and emits the same events as Electron. A reference
image should pin runtimes and tools; it should not silently broaden the permission
profile. CI documentation must continue to treat repository instructions, issue text,
and pull-request content as untrusted inputs.

## What Copse should preserve

Adopting a stronger runtime spine must not flatten Copse into a Codex clone. Preserve:

- multi-provider and local-model support behind the shared `LLMProvider` contract;
- readable, portable thread directories rather than a database-only source of truth;
- the rich desktop loop: diff review, terminals, browser, semantic search, SSH projects,
  settings, and visual tool state;
- compatibility layers for Claude/Cursor-style hooks and feature packs;
- explicit conservative behavior when a platform cannot enforce the advertised
  sandbox;
- the ability to run the product end-to-end with a deterministic mock provider.

## Recommended implementation sequence

### P0: Make the architecture document executable

The architecture page from #1032 (now merged as `site/architecture.html`) is a useful
visual index, but a 133 KB inline HTML snapshot with hundreds of source references will
drift unless the repository can verify it. It shipped without a validation path, so it
should not yet be treated as canonical system design. The following follow-up work would
make it maintainable:

- move nodes, edges, source paths, statuses, and guarantees into a reviewable data
  model;
- generate the static page from that model;
- validate every file reference and edge endpoint in CI;
- label each view as **current**, **target**, or **migration**;
- annotate process, persistence, network, trust, and OS-sandbox boundaries;
- remove the fixed “main delta” commit archaeology, or generate it from an explicit
  comparison range outside the durable architecture model;
- state platform-specific enforcement rather than showing one generic sandbox path;
- add an owner or source-of-truth link for each planned subsystem.

Exit gate: changing or deleting a referenced source file fails a focused architecture
validation test, and the page contains no hand-maintained commit-count claims.

### P1: Complete thread execution ownership

Finish the routing and mutable-state audit from `docs/plans/thread-worktrees.md`. Add
concurrency tests before enabling any isolated checkout default.

Exit gate: two concurrent turns can operate on the same relative paths without sharing
backups, diffs, todos, hooks, model selection, terminals, background processes, or ACP
sessions. No run-scoped tool derives authority from the renderer's active project.

### P2: Establish the canonical event model

Version the thread event vocabulary, add projection versions, and migrate
`llm-history:<threadId>` from independent durable state to a rebuildable provider
projection. Add integrity and crash-recovery tests around append, attachment, and
catalog updates.

Exit gate: deleting the provider-history cache does not lose a resumable conversation,
and a recovery command can validate and rebuild all derived state.

### P3: Unify the runtime contract

Define the common Thread/Turn/Item-equivalent protocol, generate types and schemas, and
adapt Electron IPC and ACP to it. Include approvals, cancellation, user input, tool
streaming, capabilities, and bounded queues.

Exit gate: one protocol conformance suite drives both an Electron transport adapter and
an ACP/headless adapter through the same lifecycle.

### P4: Add enforceable cross-platform profiles

Persist declarative permission profiles and report runner capabilities. Add Linux
containment using a maintained primitive such as bubblewrap or an equivalent container
boundary. Design a supported Windows boundary before claiming sandbox parity. Separate
provider credentials from child processes and remote execution.

The detailed local/SSH/cloud capability contract, brokered-egress design, secret
mediation, lifecycle state machine, and acceptance gates are maintained in
[`execution-runtime-security.md`](execution-runtime-security.md); P4 should be delivered
through that plan rather than a parallel implementation.

Exit gate: platform-matrix tests prove deny rules and writable-root constraints at the
OS boundary, and the UI accurately identifies reduced-capability environments.

### P5: Add optional first-class agent and automation adapters

Give durable child agents normal thread ownership and lifecycle operations. Then build
headless/CI integration and a reproducible reference environment on the stable runtime
contract.

Exit gate: a child agent can be resumed, cancelled, archived, and inspected without its
parent process, and a headless run produces the same canonical events as the desktop.

## Adopt, adapt, or decline

| Codex OSS pattern                          | Decision    | Reason                                                                                            |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| Versioned bidirectional runtime protocol   | Adopt       | Decouples lifecycle correctness from Electron and makes ACP/headless parity testable.             |
| Generated client types and JSON Schema     | Adopt       | Prevents protocol drift and enables fixtures, compatibility checks, and external clients.         |
| Explicit Thread/Turn/Item lifecycle        | Adapt       | Use equivalent semantics, but retain Copse's readable Markdown/event storage and UI projections.  |
| First-class parent/ancestor agent threads  | Adapt       | Promote durable agents without turning every short subagent call into top-level clutter.          |
| Permission profiles plus OS enforcement    | Adopt       | Policy, approval, containment, process privilege, network, and secrets are distinct layers.       |
| Rust daemon as an immediate rewrite target | Decline     | The important gain is the contract and ownership model; a rewrite would delay those invariants.   |
| OpenAI-specific provider assumptions       | Decline     | Provider neutrality and local-model support are core Copse advantages.                            |
| Database-only canonical history            | Decline     | Copse's inspectable, portable thread store is worth preserving; databases may remain projections. |
| Universal reference image                  | Adapt later | Valuable for headless/CI reproducibility after protocol and profiles are stable.                  |

## Implications for #1032

#1032 merged the architecture page as an undated snapshot without a validation path.
That is fine for orientation, but the page should not yet be described as the canonical,
source-verified system design. Its strengths are broad source coverage, multiple views,
source inspection, responsive presentation, and accessibility affordances. The changes
above would turn those strengths into a maintainable architecture artifact.

At minimum, follow-up work on `site/architecture.html` should:

1. identify the inspected commit and label the diagram as a snapshot;
2. distinguish shipped behavior from plans, especially thread worktrees and platform
   containment;
3. remove or generate the historical “main delta” section;
4. add a validation path for file references and graph integrity;
5. explain that the thread store and provider history are currently separate;
6. document the runtime/process boundary rather than only the module call graph.

That makes the page honest today and creates a clean route toward a durable design
artifact as P0 is implemented.
