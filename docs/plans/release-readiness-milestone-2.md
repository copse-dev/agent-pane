# Release-readiness milestone 2

**Status:** Proposed portfolio; audited against `main` and GitHub on 2026-07-21.

**Tracking:** [Milestone 2 — Release readiness](https://github.com/copse-dev/agent-pane/milestone/2)

This plan covers every open item in milestone 2. It is intentionally one planning document, but it
is not a proposal for one implementation branch. The work ranges from issue closure to security
boundaries and persistent-data migration. Each independently releasable phase below should be its
own pull request, with the issue number in the title and acceptance evidence in the description.

## Portfolio decision

Keep the plans together so cross-cutting dependencies remain visible. Split implementation by the
boundaries in the table; in particular, never combine terminal execution, semantic-index limits,
or permission auditing with unrelated release work.

| Item                                                                              | Current state                                                                | Risk        | Recommended implementation boundary                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| [#607 ACP permission modes](#607-acp-permission-modes)                            | Core implementation is on `main`                                             | Low         | Acceptance/closure only                                   |
| [#830 ACP warm-session resume](#830-acp-warm-session-resume)                      | Resume path is on `main`                                                     | Low–medium  | Acceptance first; durable/load fallback is a follow-up    |
| [#832 ACP Tier-2 probes](#832-acp-tier-2-behavioral-probes)                       | One write-routing probe is on `main`                                         | Medium      | One harness PR, then findings-only updates                |
| [#785 longer `run_shell` timeouts](#785-long-running-run_shell-commands)          | Unimplemented                                                                | Low         | One schema/lifecycle PR                                   |
| [#787 pipeline exit masking](#787-pipelines-mask-run_shell-failures)              | Unimplemented                                                                | Medium      | One shell-semantics PR                                    |
| [#993 move `llm-history`](#993-move-llm-history-out-of-electron-store)            | Implemented (sidecar + migration)                                            | High        | Landed as one storage+migration PR                        |
| [#998 catalog/lazy thread loading](#998-catalog-based-lazy-thread-loading)        | Catalog exists; renderer still folds all threads                             | High        | Main/store API PR, then renderer hydration PR             |
| [#995 main-loop watchdog](#995-main-process-event-loop-lag-watchdog)              | Unimplemented                                                                | Medium      | One invisible diagnostics PR                              |
| [#994 aged-profile startup e2e](#994-aged-profile-startup-e2e)                    | Unimplemented                                                                | Medium      | Dedicated fixture/config/CI PR after #993 and #998        |
| [#806 artifact-size budget](#806-artifact-size-budget-and-packaged-footprint)     | Unimplemented                                                                | Medium–high | Reporting/budget first; each footprint reduction separate |
| [#795 semantic-index scale guard](#795-semantic-index-scale-guard)                | Policy/status/sequencing landed; nested-repo + daemon wait follow-ups remain | High        | Nested-repo excludes/cache PR, then daemon wait lifecycle |
| [#623 ACP client-owned terminals](#623-acp-client-owned-terminals)                | Unimplemented                                                                | Very high   | Shell-core extraction, protocol backend, then UI          |
| [#840 audit-trail draft PR](#840-salvage-the-audit-trail-draft)                   | Draft is conflicted and incomplete                                           | High        | Salvage only a reviewed infrastructure slice              |
| [#656 durable permission audit trail](#656-complete-permission-decision-auditing) | Partially explored by #840                                                   | Very high   | Contract/event PR, persistence PR, then export/UX         |

## Delivery order

1. **Close already-shipped work:** validate #607 and #830 against real adapters; do not reopen
   their architecture while preparing the release.
2. **Remove startup amplification:** land #993, #998, and #995, then use #994 as the integrated
   aged-profile gate.
3. **Harden shell ergonomics:** land #785 and #787 as independent changes.
4. **Make packaging measurable:** land #806 reporting and budgets before choosing reductions.
5. **Finish ACP evidence:** complete #832 before committing to the high-risk #623 terminal design.
6. **Bound expensive background work:** land #795 only after benchmark-derived thresholds are
   reviewed.
7. **Make the security record trustworthy:** resolve #840 deliberately, then deliver #656 in
   contract-first slices.

The release does not need to wait for speculative expansion of issues whose stated acceptance is
already on `main`. Conversely, a partial audit trail or partially policy-compliant terminal backend
must not be called release-ready.

## Shared rules of execution

- Every implementation PR includes focused unit/component tests and the commands required by
  `AGENTS.md`. User-visible changes also include a focused WebdriverIO visual eval and screenshot.
- Persistent-data migrations are versioned, idempotent, crash-safe, and tested against malformed,
  ambiguous, and interrupted input. Legacy data is removed only after its replacement is durable.
- Logs, fixtures, and probe summaries contain no prompts, command arguments, environment values,
  file contents, or provider tokens unless a field is explicitly redacted at its source.
- A timeout is not automatically an error. Long-running background work must distinguish “still
  progressing” from “failed”.
- Agent-hook work follows [hooks-and-feature-packs.md](hooks-and-feature-packs.md). If a permission
  event contract changes, update that plan and its golden payload snapshots in the same PR.
- Thresholds for time, memory, repository size, and package size come from a checked-in baseline
  gathered on named platforms, not one developer laptop.

## Item plans

### #607 ACP permission modes

**Issue:** [ACP: drive the agent's permission mode via session modes](https://github.com/copse-dev/agent-pane/issues/607)

**Outcome:** Close the issue after proving the shipped session-mode behavior is safe on supported
adapters. Do not build a second permission-mode system.

The settings model, mode discovery/cache, picker, `session/set_mode`, and the macOS-sandbox-aware
Claude default are already on `main`. ACP v1 now treats session modes as deprecated in favor of
[session config options](https://agentclientprotocol.com/protocol/v1/session-modes), but the
existing protocol remains valid for current agents.

Plan:

1. Add an acceptance matrix for Claude, Codex, and Cursor: advertised modes, configured selection,
   stale selection, mode rejected by the agent, and an agent with no mode capability.
2. Verify the selected mode is sent before the first prompt, persists across app restart, and falls
   back without weakening prompts when the advertised set changes.
3. Pin the invariant: `acceptEdits` is the automatic default only when the native macOS project
   sandbox is active. Linux, Windows, sandbox-init failure, and disabled auto-run remain prompt-first.
4. Record a real-adapter smoke in #832. If it passes, close #607 and file a separate compatibility
   issue for session config options rather than expanding this milestone item.
5. Keep the “an approval cannot lift a seatbelt for a client-owned process” UX concern with #623,
   where unsandboxed retry can be implemented correctly.

Exit: fake transport tests cover every fallback, one real adapter changes modes successfully, and
issue #607 links the evidence and closes without code churn unless a regression is found.

### #830 ACP warm-session resume

**Issue:** [ACP: use session/load|resume for warm agent sessions](https://github.com/copse-dev/agent-pane/issues/830)

**Outcome:** Accept the resume-first session pool already on `main`, then separate any durable
cross-restart or load-only compatibility work.

Plan:

1. Verify idle eviction and transient disconnect retain an opaque resume candidate and call
   `session/resume` before replaying history.
2. On resume, resend the complete context required by the
   [ACP session setup contract](https://agentclientprotocol.com/protocol/v1/session-setup): cwd, MCP
   servers, and additional directories. A fingerprint mismatch creates a fresh session.
3. Test resume success, expired ID, unsupported resume, configuration change, cancellation during
   resume, and a single fresh-session fallback. A failed resume must not duplicate replayed messages.
4. Run the resume scenario in #832 against at least one real adapter. Close #830 if this satisfies
   its warm-session scope.
5. If GA requires process-restart recovery, open a follow-up that stores only an opaque session ID,
   adapter capability, and a sanitized configuration fingerprint in thread metadata. Never persist
   provider environment values.
6. Treat `session/load` for load-only agents as another compatibility slice. During load, buffer or
   mark replayed history updates so they cannot duplicate the renderer transcript.

Exit: warm resume is proven end-to-end, rejection falls back once, and any larger persistence/load
scope has an explicit issue instead of silently expanding #830.

### #832 ACP Tier-2 behavioral probes

**Issue:** [ACP eval: Tier-2 behavioral probes](https://github.com/copse-dev/agent-pane/issues/832)

**Outcome:** Turn the existing single write-routing probe into a repeatable scenario runner that
measures the six behaviors needed by release decisions.

Plan:

1. Replace the fixed probe body with a scenario registry. Each scenario declares setup, prompt,
   observations, cleanup, and a sanitized result schema.
2. Implement scenarios for cooperative filesystem write, explicit shell-write twin, permission
   request shape and metadata, resume/load lifecycle, stdio and HTTP MCP forwarding, and mid-turn
   cancellation.
3. Add `--repeat N` (default 3 for manual real-adapter runs). Isolate every repetition in its own
   temporary workspace and session; report frequencies rather than one anecdotal pass.
4. Keep raw JSON-RPC NDJSON local, gitignored, permission-restricted, and marked as possibly
   secret-bearing. Commit only sanitized matrices and conclusions to `docs/acp-support-findings.md`.
5. Add deterministic fake-agent scripts for every scenario so CI validates orchestration and result
   extraction without provider accounts.
6. Run signed-in probes against the supported adapter/version/OS combinations and record date and
   version. Unsupported behavior is a valid result when explicit.

Exit: all scenarios report `N/N`, a measured failure rate, or “unsupported”; cancellation never
hangs; resume distinguishes restoration from replay; and advertised MCP transports are exercised.

### #785 Long-running `run_shell` commands

**Issue:** [`run_shell` timeout is hard-capped at 300s](https://github.com/copse-dev/agent-pane/issues/785)

**Outcome:** Permit bounded long builds without making foreground commands immortal.

Plan:

1. Export named timeout constants and increase the schema maximum from five minutes to a reviewed
   ceiling (proposed starting point: 30 minutes). Retain the current short default.
2. Make the schema error name the maximum and recommend `run_background` for watchers, dev servers,
   and intentionally unbounded processes.
3. Keep foreground process-tree termination, abort handling, and output caps unchanged; prove the
   longer timer does not bypass any of them.
4. Test the old 300,001 ms boundary, the new maximum, one millisecond over it, abort, timeout, and
   child-process cleanup.
5. Update tool documentation. Do not silently convert a foreground command into a background task,
   because its permissions, output, and lifecycle differ.

Exit: a representative long-build duration validates and executes, values above the ceiling fail
with one actionable message, and timed-out descendants do not survive.

### #787 Pipelines mask `run_shell` failures

**Issue:** [Piping output through `tail`/`head` masks the non-zero exit code](https://github.com/copse-dev/agent-pane/issues/787)

**Outcome:** Preserve the producer's failure so runner-verified sandbox violations can offer the
existing unsandboxed retry.

Plan:

1. Add a small tokenizer/parser that recognizes a top-level POSIX pipeline without mistaking quoted
   or escaped `|` characters. Cover every pipeline, not a hard-coded `head`/`tail` list.
2. Execute recognized local POSIX pipelines with `pipefail` while preserving the user's command
   bytes. Use the same shell and command for sandboxed execution and any approved unsandboxed retry.
3. Do not infer a failure from sandbox-violation logs when the final command exits zero. That
   invariant prevents incidental denied probes from manufacturing an escalation prompt.
4. Do not assume remote/Windows shells support Bash `pipefail`. Preserve current behavior there,
   document explicit `set -o pipefail` guidance, and create a capability follow-up if needed.
5. Test `false | tail`, a successful `printf | head`, a quoted pipe, explicit existing pipefail,
   masked sandbox denial, and a zero-exit command with incidental violations.

Exit: a failing producer produces a non-zero tool result and the retry offer only when the runner
also confirms a sandbox violation; successful pipelines remain silent.

### #993 Move `llm-history` out of electron-store

**Issue:** [Move llm-history out of electron-store config.json](https://github.com/copse-dev/agent-pane/issues/993)

**Outcome:** Store provider-format history beside its thread so `config.json` remains small and
unrelated writes stop serializing all conversations.

Plan:

1. Add an atomically replaced, versioned per-thread history sidecar under the thread directory
   (for example `agent-history.json`). This is a snapshot, not an append-only log, because context
   trimming replaces history.
2. Add thread-store methods to load, save, clear, and delete the sidecar using trusted project and
   thread IDs. Corrupt or future-version files fail closed to fresh provider history without
   damaging the human transcript.
3. Change `agent:estimateContext` and `agent:clearHistory` to include `projectId`; run and retry
   already have project context. No API may resolve a sidecar from a globally unique `threadId`
   assumption.
4. Run migration after legacy thread migration and before the first window. For each
   `llm-history:*` key, resolve exactly one owner, atomically write the sidecar, then mark it migrated.
   Missing or ambiguous ownership stays in legacy storage with a metadata-only warning.
5. Add a bulk prefix migration to the electron-store adapter so successful keys are removed in one
   final `config.json` rewrite. Deleting keys one at a time recreates the startup amplification.
6. Make migration idempotent: sidecar writes happen first, replacement is atomic, and the legacy
   rewrite happens last. A restart after interruption safely repeats work.
7. Update the thread-store format and recovery documentation. Do not log history values.

Validation:

- Tests cover zero/one/multiple owner matches, interruption, corrupt sidecars, future versions, and
  repeated execution.
- A restart preserves context estimation, retry, clear-history, and context trimming.
- Tests assert one legacy-config rewrite, no successful `llm-history:*` keys remain, and subsequent
  thread activity does not grow `config.json`.
- #994 boots a multi-megabyte legacy configuration through the real migration.

### #998 Catalog-based lazy thread loading

**Issue:** [Project open folds and ships every message](https://github.com/copse-dev/agent-pane/issues/998)

**Outcome:** Opening a project loads bounded sidebar metadata, then folds only the active thread and
threads that actually need to run.

Plan:

1. Introduce a renderer `ThreadSummary` separate from `Thread`. Extend catalog/meta fields only as
   needed for the sidebar, queued state, drafts, and status. Never represent “not loaded” as
   `messages: []`: blank-thread normalization and autosave could prune or overwrite real content.
2. Add main IPCs to list catalog summaries and load one validated `(projectId, threadId)`. Keep bulk
   folding internal for migration, export, diagnostics, or tests—not project activation.
3. Store summaries and hydrated threads separately. Project activation loads the catalog and then
   the selected thread; switching uses in-flight dedupe and a generation guard so a slow previous
   selection cannot replace the current one.
4. Hydrate queued/running background threads on demand. Show a deterministic loading state and a
   recoverable error if a selected thread is corrupt.
5. Refactor persistence baselines to use metadata/catalog versions. Catalog-only entries never
   enter full-thread normalization, pruning, or rewrite paths.
6. Invalidate summary and hydration caches on rename, delete, event append, recovery, and project
   removal. Preserve catalog rebuild and append-only recovery behavior.
7. Add a benchmark fixture with many threads, long transcripts, and image blobs.

Validation:

- Main/store tests prove the list IPC does not fold messages/read blobs and single-thread load
  validates project ownership.
- Controller tests cover out-of-order switches, dedupe, deletion while loading, corrupt selection,
  and “unloaded is never blank”.
- Persistence tests prove opening a catalog cannot prune or rewrite an unloaded thread.
- A focused visual eval covers a new loading/error state if the DOM changes.
- #994 shows project-open work scales with metadata plus one active thread, not transcript bytes.

### #995 Main-process event-loop-lag watchdog

**Issue:** [Main-process event-loop-lag watchdog](https://github.com/copse-dev/agent-pane/issues/995)

**Outcome:** Emit bounded, privacy-safe evidence when synchronous main-process work stalls the app.

Plan:

1. Add a lifecycle-owned watchdog using a monotonic clock. Sample on a short interval, calculate
   drift, `unref` the timer, and stop it during app shutdown.
2. Use reviewed warning/severe thresholds plus cooldown/coalescing. One long stall produces one
   structured record, not hundreds of catch-up warnings.
3. Add a bounded ring of phase markers around startup, migrations, tool probing, sandbox setup,
   window creation, handler work, and indexing. Include lag, memory counters, latest phase, and
   durations—never paths, prompts, commands, or contents.
4. State that a heartbeat observes lag after the loop resumes; it cannot recover the blocking stack.
   Inspector/CPU-profile capture is a separate opt-in, time-bounded diagnostic mode.
5. Expose test-only timing markers to #994 so startup budgets use app phases rather than WebDriver
   connection time.

Validation: fake-clock tests cover drift, thresholds, cooldown, coalescing, clock jumps, and cleanup;
an integration test deliberately blocks the main loop and asserts one redacted warning. This is
diagnostics-only and does not need a screenshot.

### #994 Aged-profile startup e2e

**Issue:** [CI only ever boots pristine profiles](https://github.com/copse-dev/agent-pane/issues/994)

**Outcome:** CI boots a realistically worn profile and fails on catastrophic startup-time or memory
regressions.

Plan:

1. Create a dedicated WebdriverIO configuration or pre-launch seed hook. The ordinary harness
   creates a pristine user-data directory too late for this scenario.
2. Generate a deterministic aged fixture before Electron launches: multiple projects, many
   filesystem-native threads, long transcripts, image blobs, a multi-megabyte legacy
   `llm-history:*` config, thousands of files, and bounded ignored/nested directories. Generate
   large content during setup instead of committing large blobs.
3. Measure main-module start through a renderer “interactive” acknowledgement using #995 markers.
   Sample per-process RSS/working set through an app-owned test endpoint; do not time WebDriver.
4. Test two boots. The first proves #993 migration and usability; the second proves steady-state
   startup, a small config, no migrated legacy keys, and #998's bounded catalog path.
5. Establish platform-specific warning/failure budgets from several CI baseline runs. Keep the job
   serialized and outside screenshot sharding; publish measurements even on success.
6. Run a required release-readiness sentinel on PRs, with the full fixture nightly and before release
   if its runtime is too expensive for every change.

Exit: both boots reach an interactive thread, search and send-message smoke checks pass, migration
is durable, and time/memory stay within a reviewed budget with useful failure diagnostics.

**Why this is the gate that was missing.** In July 2026 startup reached roughly 8.3s on a real
profile and was reported by a user, not by CI. Nothing was wrong with the tests — every dominant
cost is proportional to something a pristine profile does not have, so all of them measure ~0 in CI
and the regression is invisible by construction:

| Cost                                        | Scales with                    | Measured in CI today                |
| ------------------------------------------- | ------------------------------ | ----------------------------------- |
| Folding every thread on project open (#998) | threads × messages × blob size | ~0 — no threads                     |
| `llm-history` migration scan (#993)         | thread count                   | ~0 — no history                     |
| Project skill scan                          | workspace tree size            | ~0 — small checkout                 |
| MCP connect (30s/server timeout)            | configured servers             | ~0 — none configured                |
| Tool-availability probes                    | fixed (~9 process spawns)      | measured, but off the critical path |

Only the last row is size-independent, and it was the one cost anyone could have caught. Step 2's
fixture is what makes the other four observable, so it is the load-bearing part of this plan rather
than setup detail.

`reportStartupBudget` (`src/main/services/diagnostics/startup-budget.ts`) is the interim half: it
consumes #995's phase timeline, logs the boot breakdown on every launch, and warns on a phase over
its ceiling. That gives a real machine a number to report and a paste-ready timeline, but it is not
a gate — it cannot fail a build, and CI still never boots a profile large enough to trip it. The
fixture above remains the actual prevention.

### #806 Artifact-size budget and packaged footprint

**Issue:** [Set an artifact-size budget and reduce the packaged app footprint](https://github.com/copse-dev/agent-pane/issues/806)

**Outcome:** Make package growth visible and enforceable before removing or downloading components.

Plan:

1. Add a packaging report that records, per architecture, the application bundle, `app.asar`,
   `app.asar.unpacked`, Electron frameworks, Gortex payload, installers/archives, blockmaps, and top
   contributors. Emit machine-readable JSON and a Markdown CI summary.
2. Commit a per-platform/architecture budget file with a reviewed baseline, warning budget, and hard
   ceiling. Start by reporting, validate stable measurements, then make the ceiling required.
3. Measure both compressed distribution size and installed/uncompressed size. A percentage-only
   budget is insufficient for a large existing artifact.
4. Audit the import/build graph for HuggingFace, ONNX/native runtimes, Rampart, Gortex, locales, and
   unpacked binaries. Record which capability owns every large component before changing it.
5. Land reductions independently: prune demonstrably unused architectures/providers/locales;
   preserve current Gortex per-architecture thinning; verify signatures after each packaging change.
6. Treat on-demand download of Gortex or local-model assets as a product/security design: pinned
   checksum, signed source, progress/cancel, offline behavior, cache recovery, proxy support, and a
   useful fallback are required. Do not trade package size for a broken first-run experience.
7. Put the report and budget before attestation/publish in release CI and upload it with artifacts.

Exit: every release artifact has a readable size diff, unexplained growth fails before publish, and
each reduction passes packaged smoke tests for semantic search and affected local features on every
shipped architecture.

### #795 Semantic-index scale guard

**Issue:** [Guard against large vendored/nested repos in umbrella workspaces](https://github.com/copse-dev/agent-pane/issues/795)

**Outcome:** Preserve fast text search while preventing semantic indexing and recursive watching
from overwhelming large umbrella workspaces or the shared daemon.

**Landed (policy/status PR):**

1. ✅ Pure `decideWorkspaceIndexPolicy` (`workspace-index-policy.ts`) with path/byte/nested inputs,
   independent semantic/watch modes, and suggested child-repo excludes.
2. ✅ Startup sequences file-index stats → policy → optional Gortex/`fs.watch` (`workspace-indexing.ts`
   - `workspace-index-gate.ts`). Over-cap roots keep text search and surface `limited`/`skipped`.
3. ✅ Footer chip + component tests + focused screenshot eval for the skipped state. No sticky
   “index anyway” UI yet (test override only).
4. ✅ Recursive `fs.watch` gated by the same policy; app-owned rebuilds still refresh the file index.

**Remaining:** 4. Distinguish a timed-out `track --wait` from a dead daemon. Probe status/progress after timeout,
retain `building` while work advances, and schedule one low-frequency bounded poll. Never stack
duplicate tracking commands. 5. Add bounded nested-repository discovery. For child repos only, use cheap tracked-file/byte counts
with time/output caps and add workspace-relative anchored excludes above a reviewed threshold.
Never exclude the selected root itself. (Policy already emits `suggestedExcludes`.) 6. Cache discovery decisions with repository HEAD/config fingerprints and invalidate them when the
relevant state changes. If discovery is incomplete, the global cap remains the safety net.

- Replace conservative caps with checked-in benchmark baselines when review lands.
- Optional sticky “index anyway” override in Settings.

Exit: the umbrella fixture never starts unbounded semantic/watcher work, ordinary repositories are
unchanged, timeout-with-progress stays `building`, one project cannot starve another through the
daemon, and users retain text search plus an understandable status.

### #623 ACP client-owned terminals

**Issue:** [ACP terminal/*: client-owned shell with native sandbox + unsandboxed retry](https://github.com/copse-dev/agent-pane/issues/623)

**Outcome:** Implement the [ACP terminal contract](https://agentclientprotocol.com/protocol/v1/terminals)
without creating a second, weaker command policy.

This item is design-gated. #832 must first show which supported agents actually use terminals and
how. The first implementation PR is headless; terminal UI follows only after protocol and security
behavior are stable.

Phase A — shared execution core:

1. Extract a reusable shell policy/runner from `run_shell`: permission decision, approved
   safe-install rewriting, environment scrubbing, worktree baseline/adoption, sandbox routing,
   runner-verified violation attribution, and unsandboxed retry. Native and ACP paths share it.
2. Keep terminal processes separate from the user-facing PTY service. Create a manager owned by one
   pooled ACP session; use unguessable IDs scoped to that session.
3. Validate cwd against trusted thread execution roots, cap command/argument/environment sizes,
   scrub inherited secrets, cap terminal count, and clamp `outputByteLimit`.
4. Maintain a tail buffer truncated at a UTF-8 character boundary. Define states for running,
   retry-pending, exited, killed, and released; settle waiters once.
5. On a runner-confirmed sandbox violation, retain the terminal while prompting. Approval restarts
   the same command unsandboxed with an output marker; decline finalizes the sandboxed failure.
   Never use output text alone to authorize retry.
6. Releasing or disposing a session kills remaining processes and invalidates IDs. Worktree
   retirement disposes its ACP pool before deleting execution state.

Phase B — ACP protocol:

1. Register create, output, wait-for-exit, kill, and release handlers. Advertise terminal capability
   only when every handler and lifecycle owner is active.
2. Return from create without waiting; preserve output for UI content references after release;
   reject cross-session IDs and post-release operations deterministically.
3. Add loopback contract tests for concurrency, truncation, UTF-8, wait/kill races, cleanup, denied
   cwd, sandbox violation/retry, and session isolation.

Phase C — renderer:

1. Map ACP terminal tool-call content to a terminal-reference card and stream bounded snapshots or
   deltas without duplicating output.
2. Retain final output after protocol release and distinguish running, failed, killed, and retried.
3. Add component DOM tests and focused WebdriverIO screenshots for visible terminal states.

Phase D — acceptance:

Run #832 terminal scenarios against supported adapters. Decide explicitly whether v1 remains a
piped process (recommended) and defer PTY/interactive input until protocol/product require it.
Update the ACP support plan and permission-platform documentation.

Exit: native and ACP commands share one security policy, all terminal methods conform, cleanup is
bounded, unsandboxed retry is runner-verified and user-approved, and one real adapter uses the path.

### #840 Salvage the audit-trail draft

**PR:** [Add a durable permission-decision audit trail](https://github.com/copse-dev/agent-pane/pull/840)

**Outcome:** Decide whether to salvage a narrow infrastructure slice from the conflicted draft;
never merge it merely to make milestone bookkeeping green.

The draft adds a per-project `decisions.jsonl`, partial approval/classifier/hook records, redaction,
and guarded IPC. It conflicts with current `main` and does not record every final decision,
correlate decisions to the thread spine, or provide a complete export/integrity contract.

Plan:

1. Rebase and inventory by responsibility: schema/redaction, append storage, approval capture,
   classifier capture, hook capture, IPC/export, and tests. Compare each with current thread-store
   and canonical-hook code; discard duplicate or obsolete wiring.
2. Choose whether this is a narrow foundation or is parked in favor of clean #656 slices. The
   recommended salvage is versioned schema validation, redaction helpers, path-safe append/read
   primitives, and corruption/concurrency tests only.
3. Do not retain inline hook integrations that diverge from
   [hooks-and-feature-packs.md](hooks-and-feature-packs.md). Hook records subscribe to the one
   canonical permission event after its contract is sufficient.
4. Document accepted gaps in the PR and link each to a #656 phase. A timeout or window close must
   not be mislabeled as explicit user denial.
5. Re-run full `npm run check`; because this touches IPC and thread-store behavior, also run build
   and focused e2e even if the salvaged slice is visually invisible.

Exit: the PR is closed with useful commits referenced by #656 or rebased into a small, reviewable,
green foundation whose omissions are impossible to mistake for complete auditing.

### #656 Complete permission-decision auditing

**Issue:** [Durable permission-decision audit trail](https://github.com/copse-dev/agent-pane/issues/656)

**Outcome:** Produce a trustworthy, privacy-preserving record of decisions that actually authorized,
denied, sandboxed, or deferred privileged work.

Phase 0 — contract and threat model:

1. Write a source/outcome coverage matrix for shell static policy, classifier input, user approval,
   runner sandbox result/retry, MCP decisions, command hooks, and remembered decisions.
2. Define a versioned record with project/thread/turn correlation IDs, monotonic sequence, timestamp,
   tool category, policy source, sandbox scope, final outcome, reason codes, and redacted subject.
   Distinguish `allow`, `deny`, `prompted-allow`, `prompted-deny`, `dismissed`, `timed-out`,
   `sandboxed`, `retry-allowed`, and `hard-deny` where applicable.
3. Define privacy before persistence: allow-listed structural fields, keyed hashes when correlation
   is required, no raw arguments/prompts/env/path content, rotation/retention, export,
   malformed/future-line behavior, and local attacker expectations.

Phase 1 — canonical event:

1. Extend the canonical permission event so it represents the final decision, not only the early
   static verdict. Keep one event with N subscribers; update the binding hook plan, schemas, and
   golden payload snapshots in the same PR.
2. Fire it regardless of whether Cursor hooks are enabled. External hooks are one subscriber;
   first-party audit persistence is another. Preserve detached hook execution, but make local append
   ordering and failure policy explicit.
3. Attach stable thread/turn/tool-call correlation at the decision boundary. Do not reconstruct
   identity later from mutable renderer state.

Phase 2 — durable storage:

1. Append versioned JSONL under the path-safe per-project store with serialized writes, bounded
   lines, startup recovery, rotation, and deterministic handling of malformed/future entries.
2. Record one terminal result for every covered decision. Intermediate classifier or prompt events
   can be linked records but cannot substitute for the final authorization outcome.
3. Treat append failures as diagnostics, not permission grants. Authorization continues from the
   policy engine, while persistence failure is visible and rate-limited.
4. Add schema conformance, concurrent append, partial-line recovery, redaction property, path
   traversal, retention, and correlation tests.

Phase 3 — read/export and operations:

1. Add a paginated, project-scoped read API with least-privilege validation. Avoid an unbounded IPC
   that loads the entire audit file into renderer memory.
2. Add an explicit export producing a redacted support bundle with schema version, integrity
   metadata, and a content warning. Choose CLI or UI from the support workflow; visible UI requires
   a focused visual eval.
3. Document retention, support collection, corruption recovery, and limits of tamper evidence. If
   cryptographic chaining is wanted, make key custody/rotation a separate reviewed design.

Exit: the coverage matrix has no unexplained gaps, every final decision is correlated/redacted,
hooks consume the canonical event without duplication, corrupt data cannot weaken authorization,
and support can export a bounded record without raw user content.

## Release gate summary

Milestone 2 is fully planned when each open item links this document and names its next PR or closure
evidence. It is delivered only when:

- #607 and #830 are closed with real-adapter evidence or explicitly respecified;
- the #993 → #998 → #994 startup chain passes an aged profile on CI;
- #785 and #787 preserve process cleanup and sandbox retry invariants;
- #806 reports and enforces artifact budgets before publish;
- #795 has benchmark-derived, user-comprehensible limiting behavior;
- #832 records evidence needed for #623 rather than assuming adapter behavior; and
- #656 is complete by its coverage matrix, whether or not part of #840 is salvaged.
