# Plugin capability API

Status: stage 1 implemented; a first-party session-only interactive-client approval preview now
provides part of stages 2–3. General provider registration and the rest of stages 2–5 remain open.

## Task brief

Plugins and external companion clients need supported access to pending human decisions,
thread activity, resolved appearance and thread navigation. Today those services are tied to
individual transports or renderer APIs. Provide narrow, versioned capabilities with explicit
grants and one host-owned enforcement path, so consumers do not depend on private settings,
arbitrary IPC or a particular UI being foregrounded.

Base: `f9b2c2549e3eaef159a4c9220f5779719ca94b53`.

Risk is high: later stages touch authentication, persisted credentials, IPC and approval authority.
Follow `hooks-and-feature-packs.md` decisions 15 and 17, `shell-permissions.md`, the renderer API
compatibility rules and `testing-strategy.md`. Each stage is a separate review unit. Completing
a foundation stage does not establish a supported external API.

## Observable acceptance criteria

- A user enables an API-providing plugin, connects a consumer, inspects its requested capabilities
  and project scope, and grants access. No private-file access or manually copied credentials.
- An authorized consumer obtains initial pending-decision state and subsequent changes while
  Copse is backgrounded. Every request identifies its project, thread and complete decision meaning.
- A human answer settles only the exact displayed session/request/revision. Cancellation,
  replacement, another client's answer, disconnect, revocation and restart invalidate stale answers.
  Repeated delivery cannot settle twice. Read permission alone cannot submit an answer.
- Consumers can request bounded activity and resolved semantic theme state, subscribe to changes,
  and open a thread through explicit capabilities. None grants general settings, unrestricted transcript,
  filesystem, shell, hook or arbitrary IPC access.
- Unsupported or incompletely represented prompts are read-only and direct the user to Copse.
  Approval responses grant once; no remembered grants, task leases or automatic approvals.
- Disabling a provider plugin atomically removes its API contributions and closes affected
  subscriptions/in-flight calls. Disabling a consumer or revoking its grant ends its access.
  Unrelated consumers and historical transcript rendering continue to work.
- Different client/host versions negotiate explicitly. Malformed, oversized, expired,
  wrong-scope and unauthorized messages fail closed with documented errors.

## Interactive client consent update

Interactive plugin clients pair for viewing and decision submission together. The desktop prompt
states that scope explicitly and offers Connect client or Reject, with no read-only mode or extra
checkbox. Each pairing interrupts and hides ordinary approval batches, is answered individually,
and restores unanswered thread requests afterwards. The shared authentication core still preserves
existing mobile read/control credentials; plugin clients always receive session-only control
within their supported approval scope. No existing persisted mobile grant is upgraded.

## Recent activity and navigation preview

The first-party interactive-client transport adds generic `activity.read` and `threads.open`
operations under the existing session-pairing consent. The desktop explicitly discloses recent
chat titles, bounded selected-chat text and navigation across configured projects. Activity is a bounded metadata projection
of settled chats. A separate on-demand `threads/content` operation reads at most eight visible user/assistant messages and 24,000 characters for an exact current completion. It excludes reasoning, tools and attachments, rechecks eligibility/authority after hydration and never exposes arbitrary history. Completion ordering uses lastSettledAt with a documented
legacy used-chat fallback; running/waiting, archived, hidden and interrupted chats are excluded.
The authenticated Open operation validates the exact project/thread against current activity or
supported pending approvals and rechecks authority after asynchronous reads. It targets the same
host's ready window, with no client-supplied executable, URI or path. This does not complete the
provider/consumer registration framework, general activity subscriptions, theme or durable grants.

## Shared client authentication follow-up

Base: `b8f2014b521629701abb9eb43e3f4b929f0ebba5`. Mobile and interactive plugin clients
must use the same bearer credential implementation and desktop-consent pairing lifecycle.
Preserve existing mobile token hashes, device IDs and read/control grants on disk; plugin
credentials remain session-only and origin-bound. Preserve each transport's Host, Origin,
peer and TLS guards and its existing operation scope. This does not implement AHP.

Acceptance: both adapters reject unpaired and read-only writes; expiry, denial, shutdown and
late consent cannot create usable credentials; pairing results are delivered once to the
requesting binding; revoked or downgraded authority is rechecked after awaited bodies. Mobile
pairing UI clears on timeout/stop. Tests cover shared mechanics, persisted mobile compatibility,
and the existing fresh-profile native approval flow. Authentication is high risk: run the full
check gate, focused auth/mobile tests and the relevant Electron specs.

Completion evidence (19 October 2026): both adapters now use `ClientCredentials` and
`ClientPairings`, with shared label/access schemas. Mobile records remain compatible; no
credential store or operation scope crosses transports. Pending mobile consent is cancelled on
timeout/stop, and approved but uncollected credentials are revoked. Failed storage writes cannot
create new in-memory authority or prevent in-memory restriction and pairing shutdown.

The final focused auth/registry run passed **35 tests**. The two native specs passed **4 cases**
across fresh profiles, including verified LAN HTTPS, existing mobile chat/run control, real
pairing, read-only enforcement, restart, revocation and stop. The external client adapter also
passed against the refactored real registry/server without protocol changes. `make build` and
all static gates passed. Full `pnpm run check`: **15,138 passed, 18 failed, 3 skipped** (15,159).
Seventeen failing titles match the previously established baseline-related set; the eighteenth
is the already reproduced dirty-working-tree small-gate assumption. Logs are
`/private/tmp/copse-shared-auth-complete-check.log`, `copse-shared-auth-unit-final.log`,
`copse-shared-auth-runtime-verified.log` and `copse-shared-auth-demo-interop.log`.

Local consent and stopped-state images were inspected: grants are explicit, control is initially
unchecked/disabled, cancelled pairing disappears, and existing saved devices remain manageable.
The LAN eval selected an unused real interface to avoid the daily app's fixed listener.
No local image replaced a Linux baseline. Canonical CI passed on the preceding `b8f2014b5216`
head; the shared-auth update still needs its own CI and complete screenshot review. The prior
review packet has 2 of 8 images inspected and cannot authorize the new head. No independent
review or AHP compatibility is claimed.

## Architecture and binding decisions

### Host services and plugin contributions

Use one main-process human-decision registry beneath the desktop prompt lifecycle. Existing mobile
control becomes an adapter over it. A snapshot feed projects pending prompts; it is neither a
second approval store nor a durable audit log. Desktop settlement and cancellation withdraw the
same registration observed by every consumer.

First-party providers register typed operations and event projections through the existing plugin
lifecycle. Contributions declare namespace, protocol version, capability, schemas, project scope
and handler. The host checks registration/declaration agreement and rejects duplicate names. The
host supplies caller identity, effective grants and captured project/thread context to handlers;
request bodies cannot impersonate a principal or select an ambient active project.

User plugin runtimes remain isolated. A manifest cannot create a listening service, import code
into main, grant itself access or expose arbitrary Electron/IPC operations. Add concrete, bounded
SDK operations for the capabilities that a user runtime may consume; do not add generic
`host.call`. Any new serializable declaration belongs under `extensions["dev.copse"]` and needs
matching manifest validation, install-review disclosure and binding-design updates in its stage.

The same capability enforcement serves isolated plugin-runtime consumers and authenticated
external clients. Transport handles framing and delivery; provider code owns service semantics.
External clients do not receive the renderer's complete API or the mobile LAN API.

Capabilities also declare eligible consumer classes. `approvals.respond` is restricted to separately
authorized interactive clients; never expose it as an agent tool or an SDK operation in an
agent-invoked runtime. A plugin cannot answer the host permission request gating its own tool.
Pairing an interactive client is a deliberate trust decision about its software; authentication
does not attest a physical human gesture. Its contract requires an explicit per-request human
action, and unsupported clients must not be described as providing trusted user decisions.

### Initial capability contract

| Capability          | Operation and scope                                                         |
| ------------------- | --------------------------------------------------------------------------- |
| `approvals.read`    | Initial pending approvals and changes, filtered to desktop-granted projects |
| `approvals.respond` | Approve once or deny an exact session/request/revision                      |
| `activity.read`     | Bounded project/thread run state; no transcript or file access              |
| `theme.read`        | Resolved semantic colors and changes; no general settings access            |
| `threads.open`      | Open a validated, accessible thread in Copse                                |

These names describe the planned surface, not shipped API. Grant viewing and responding separately;
respond requires read access to the same project/request. Permission to consume a capability never
approves an individual operation. Initially, agent questions continue through their existing mobile
adapter; a public question-answer API requires its own representation/interaction contract.

Every invocation carries a protocol version and request ID. Decision writes additionally carry the
host session, project, thread, request ID and revision observed by the consumer. The host checks
authorization again immediately before dispatch. Bind bounded idempotency retention to the
authenticated principal and exact request body; reject conflicting reuse and restart replay.

Snapshot sequences increase within one process session. Notifications may coalesce intermediate
states; consumers reconcile from a fresh snapshot on reconnect. Do not treat the sequence as a
durable replay cursor. Decode every boundary with closed schemas and enforce byte, count, rate and
backpressure limits. Never silently truncate a command or scope into an answerable prompt.

### Identity, grants and lifecycle

Pair external clients through explicit desktop consent. Store credentials using supported protected
storage; discovery metadata is non-secret and profile-scoped. The host assigns caller identity and
records the actual consumer in decision audit events. Selecting among multiple running profiles or
instances is explicit. Per-client grants distinguish capabilities and optionally restrict projects.

Start external access on loopback; enforce authentication, exact authority/origin policy and
rebind protection. A local port is not authentication. Revocation and provider/consumer disable
terminate affected subscriptions and reject subsequent writes immediately. LAN serving is separate.

Services live in main and do not depend on renderer focus. Preserve the existing prompt window
lifetime initially: background/minimized operation works; closing the owning window cancels its
requests. Running with no windows is a separate lifecycle decision.

## Delivery sequence

### 1. Shared human-decision registry

Implement `src/main/services/human-decisions.ts` and move mobile's pending map behind an adapter,
preserving its wire payloads, audit attribution and approval policy. Add detached snapshots with
explicit project/thread ownership, process-session identity, monotonically increasing revisions,
subscription cleanup, and exact-reference response validation. Notify after registration/settlement
completes, so a consumer cannot answer a half-registered prompt.

Acceptance: mobile and other host consumers share one registry; concurrent clients settle once;
stale sessions/revisions fail; replacing an ID invalidates the old reference and disposer; inputs,
snapshots and subscribers cannot mutate pending meaning; subscriber errors cannot break approval;
cancelled/answered prompts disappear. No new external authority is enabled in this stage.

Validation: focused registry/mobile/approval/ask-user tests, oracle inspection and full
`pnpm run check`. This is data plumbing with unchanged DOM, copy and wire payloads, so it has no
visual change requiring a screenshot.

### 2. Provider registry and scoped invocation

Implementation targets: contribution declarations in `packages/agent/src/plugins/plugin-manifest.ts`
and registration/lifecycle in `packages/agent/src/plugins/plugin-registry.ts`; closed protocol
schemas in `src/shared/plugin-api.ts`; host dispatch in
`src/main/services/plugins/plugin-api-controller.ts`. Keep transport concerns outside that controller.

Add typed API contributions to first-party plugin registration, with explicit declaration/schema
matching and atomic enable/disable. Add a host invocation context, per-consumer capability/project
authorization and consumer-class eligibility, result decoding, errors and subscription teardown.
Define strict versioned wire
schemas and publish the supported contract. Expose only the initial bounded approval operations;
complete their projection in stage 4 before allowing unsupported prompt shapes to be answered.

Acceptance: disabled providers cannot be called; unknown/duplicate methods are rejected; consumers
cannot forge caller context, cross project boundaries or widen a grant. Idempotency and stale
reference checks run server-side. Agent-invoked runtimes cannot acquire decision-write access,
even when their manifests request it. Tests cover provider disable during invocation/subscription,
schema limits and concurrent answers. Amend the binding plugin design and run the full check.

### 3. Consumer consent and transport adapters

Implementation targets: bounded worker/SDK messages in `packages/plugin-sdk/src/plugin-tool-protocol.ts`
and `plugin-tool-sdk.ts`; loopback serving and pairing under `src/main/services/plugins/`; consent
and client management in `src/renderer/views/settings/packs-section.ts`. Add preload bindings and
regenerate the protocol manifest when Settings gains IPC operations. A client cannot negotiate
itself into capabilities absent from its desktop grant.

Add capability declarations and bounded SDK read operations for isolated plugin consumers without
relaxing their sandbox or exposing decision submission. Add an authenticated loopback adapter for external clients, profile/instance
discovery, protected credential storage, pairing and capability negotiation. Provide Settings flows
for inspecting grants, pairing, changing project scope and revoking access. Display requested
capabilities during applicable plugin install/update review; new capability requests need consent.

Acceptance: exercise initial connection from an unpaired/ungranted consumer, desktop consent,
authorized use, reconnect and immediate revocation. Invalid origins, expired sessions, unauthorized
capabilities and wrong projects fail. Tokens never appear in discovery or logs. Add real-listener
integration tests, SDK boundary tests, focused Settings IPC/visual evidence and the full check.

### 4. Complete service projections

Implementation targets: structured approval data in `src/main/services/approval.ts`; bounded activity
projections beside `src/main/services/mobile/mobile-activity.ts`; a shared semantic theme projection;
thread opening through `src/main/services/thread-deep-links.ts`. Extract shared service code rather
than making plugin clients depend on mobile wire shapes or renderer CSS parsing.

Publish action, target, scope, warnings and advice from structured host approval data, without
parsing rendered text. Specify batched and coalesced request semantics. Requests whose full meaning
cannot be represented remain desktop-only. Export actual working/finished state, resolved semantic
theme changes, and validated thread opening through the existing window/deep-link service.

Acceptance: simultaneous background requests are attributed correctly across projects; settlement
and cancellation agree across desktop, mobile and plugin consumers; unsupported prompts reject
writes; appearance changes propagate; thread opening selects the correct owner. Add focused
service/IPC and visual evidence and run the full check. No general settings or execution API.

### 5. Consumer compatibility and production evidence

Add `plugin-api-controller.test.ts` for authorization and lifecycle, `plugin-api-server.test.ts`
for real transport boundaries, SDK protocol tests alongside the existing worker tests, and a
focused `tests/e2e/plugin-api-consent.e2e.ts` covering the real enable/pair/revoke entry path.

Provide a small reference client and authoring documentation for connection, capability discovery,
snapshots, answering, revocation and version errors. Use deterministic fixtures at dependency
boundaries; do not add test-only product options. Test at least an isolated runtime consumer and
an external client against the same host enforcement path.

Exercise installation/consent through a real approval with native and ACP agents while Copse is
backgrounded. Cover competing answers, Stop/cancellation, timeout, abandoned-call retry, multiple
projects/profiles, restart, sleep/wake, provider disable and credential revocation. Save focused
WebdriverIO evidence of consent and lifecycle UI. Document tested platforms and remaining limits;
consumer-specific presentation and distribution stay in their own projects.

## Completion evidence

### Interactive-client approval preview — 19 October 2026

The first-party `copse.plugin-client-api` capability starts an authenticated loopback approval
service behind a default-off plugin toggle and explicit desktop pairing. Grants last only for
the running service session and distinguish viewing from submitting decisions across all projects.
The preview exposes standard shell-command approvals only; unsupported kinds remain desktop/mobile-only. Disable revokes every token. The protocol is documented in `docs/plugin-client-api.md`; it is a
preview, not completion of the general provider/consumer framework or durable per-project grants.

Focused tests cover real HTTP/SSE connections, origin binding, read-only grants, exact references,
idempotency, cancellation, upgrade defaults and client provenance. The focused Electron spec
`tests/e2e/plugin-client-approvals.e2e.ts` passed through Settings enablement, real desktop consent,
a real shell approval, duplicate/stale answers and disable. Its provider is deterministic; the
permission prompt, shell execution and transport are real. Local screenshots of the Settings row
and pairing prompt were inspected for clipping, grant copy, and the initially unchecked
decision-submission checkbox. Physical client behavior is separate evidence.

Validation on the original base used Node 24.20.0 and pnpm 10.34.5:

- Focused registry, transport, plugin, mobile, approval and question tests: **246 passed**.
- `make build`: passed. Focused Electron spec: **2 passed**, including a fresh profile for
  each case, viewing-only consent, desktop denial, app restart, old-token rejection and new
  pairing. Settings/pairing screenshots were inspected.
- `pnpm run check`: all static gates passed; full unit/component suite **15,117 passed,
  18 failed, 3 skipped** (15,138 tests). The 18 failure titles exactly match the previously
  reproduced baseline-related set documented below. The full gate is not green on this machine.
- The oracle reports **broad** coverage because main-process startup changed. The complete
  unit gate was run; the focused Electron evidence does not claim the full Electron suite.

Logs: `/private/tmp/copse-client-check-final.log`, `copse-client-tests-final.log`,
`copse-client-e2e-expanded.log` and `copse-client-oracle-final.log`. Rebase/final-head checks and
CI links belong in the PR handoff. The earlier stage-1 results below describe that foundation
rather than claiming later capabilities are complete.

### Stage 1 — 19 October 2026

Working tree: `codex/plugin-capability-foundation`, based on
`f9b2c2549e3eaef159a4c9220f5779719ca94b53`; implementation is not committed. Approvals and
questions now register directly with the shared registry; mobile reads and answers through its
adapter. Its wire shapes and audit attribution are preserved. No external capability is enabled.

Validation used Node 24.20.0 and pnpm 10.34.5:

- `pnpm test -- human-decisions ask-user.test mobile-actions approval.test`: **199 passed**.
- `pnpm run oracle -- --explain` and the final `pnpm run oracle`: **HIGH** confidence.
- `pnpm run check`: all static gates passed, including TypeScript, type coverage, lint,
  formatting, generated-site consistency, reachability, oracle checks and e2e inventory checks.
  The full unit/component run reported **15,099 passed, 18 failed, 13 skipped** (15,130 tests).
- `git diff --check`: passed. No renderer/DOM/copy changes; visual evidence is not applicable
  to this foundation. No independent review has been performed.

The first sandboxed full run could not bind local fixture ports (`listen EPERM`) and was
superseded by the completed host run above. Host failures were checked against a clean checkout
of the original base, sharing the same unchanged dependencies:

- Sixteen failures reproduce directly in the original nine failing test files: Stage 0 offline
  preparation, CI Bash array handling, screenshot-review temporary-directory validation, nested
  Git signing, Python preparation, certificate verification and SSH socket path length.
- The small-gate test passes on a clean base but reproduces its `full !== skip` failure after
  adding only an inert source comment there. It assumes an empty working-tree diff.
- The initial baseline skipped Cargo because of its toolchain selection. Bundling the original
  Cargo fixture with `pnpm test -- --bundle-only src/main/project-sandbox/worktree-preparation-cargo.test.ts`
  and running that bundle with Node's test runner from the task's working directory reproduces
  the same Cargo sandbox I/O failure. This checks the original source against the same local
  toolchain context rather than treating the skip as a pass.

Local diagnostic logs are retained under `/private/tmp/`: `copse-capability-check-host.log`,
`copse-capability-focused-final.log`, `copse-capability-baseline.log`,
`copse-capability-baseline-dirty.log` and `copse-capability-baseline-cargo.log`.

Remaining: the full gate is not green on this machine. Stages 2–5 still need implementation and
their own consent, protocol, transport and real-runtime evidence before the capability API is
supported. No owning integration outcome is closed by this foundation.
