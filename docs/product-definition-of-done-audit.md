# Product definition-of-done audit

**Snapshot:** 2026-07-29

**Repository baseline:** `main` at `7cb3f382` (the tree promoted from `develop` at `51d61900`)

**Sources:** merged Git history, the [plans ledger](plans/README.md), the
[release-readiness milestone](plans/release-readiness-milestone-2.md), and live GitHub issue state

## Purpose

This audit answers two different questions that should not be collapsed:

1. Which plan or issue is the recorded owner for a product gap?
2. Does current repository and GitHub evidence show that the gap is still open?

A plan remains useful after its implementation lands, so its presence is not evidence of unfinished
work. Likewise, an issue link in a plan records ownership at the time the plan was written; it does
not guarantee that the issue is still open. Use the live-state columns below for this snapshot and
recheck GitHub before scheduling work from it.

## Definition of done

A product area is complete only when all of the following are true:

- the remaining scope has one named issue, PR, or explicit deferred decision;
- the implementation and migration path are on `main`, not only on a draft branch;
- acceptance evidence covers the real product path, including restart, cancellation, failure, and
  platform boundaries where they matter;
- user-visible changes have the focused visual eval required by [AGENTS.md](../AGENTS.md);
- durable formats, security boundaries, and operational recovery are documented; and
- the owning issue is closed or narrowed to a separately named follow-up.

“A foundation exists”, “a design PR merged”, and “a related issue is closed” are useful evidence,
but none is sufficient on its own.

## Portfolio summary

| Area                            | Current reading                                                                                 | Definition-of-done implication                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Thread storage and startup      | Substantial performance and migration work shipped after the plans audit.                       | Do not treat the `llm-history` migration as unfinished; retain the aged-profile and lazy-loading gates.                              |
| ACP                             | Client support and ACP-over-SSH exist. Recent fixes tightened sandbox and approval behavior.    | Remaining work is parity, behavioral conformance, client-owned terminals, and forwarding—not basic transport.                        |
| Worktrees and remote work       | The execution-context stack has continued to land, including UI routing and drift recovery.     | Keep [#869](https://github.com/copse-dev/agent-pane/issues/869) open until the end-to-end lifecycle and recovery acceptance are met. |
| Automations and long-lived work | Project cron, scheduled turn startup, and the P1 supervisor model exist.                        | The durable supervisor remains the owner for restart-safe reconciliation and operational status.                                     |
| Video                           | Attachment-based video analysis shipped.                                                        | Capture, remote streaming, and SSH binary-read correctness remain a distinct proposed extension.                                     |
| Prompts and evaluations         | Prompt findings and improved SkillsBench methodology shipped.                                   | Release-quality proof still needs the real product agent path and a pre-declared study design.                                       |
| Product planning                | Most plan records have an owner, but several proposed extensions still have no dedicated issue. | File or explicitly defer owners before treating those proposals as backlog.                                                          |

## Complete plan ownership map

“Recorded owner” reflects the current plans ledger. “2026-07-29 reading” reconciles that record with
newer merged history and live issue state.

| Plan                                                                              | Ledger status                    | Recorded owner                                                                                                                 | 2026-07-29 reading                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ACP client support](plans/acp-client-support.md)                                 | Active                           | [#264](https://github.com/copse-dev/agent-pane/issues/264)                                                                     | #264 is closed. Core client support is shipped; parity and conformance are now better represented by [#623](https://github.com/copse-dev/agent-pane/issues/623), [#832](https://github.com/copse-dev/agent-pane/issues/832), and adapter-specific follow-ups. |
| [ACP agents over SSH](plans/acp-over-ssh.md)                                      | In progress (Phase 1)            | [PR #1202](https://github.com/copse-dev/agent-pane/pull/1202), then [#771](https://github.com/copse-dev/agent-pane/issues/771) | #1202 merged. Remote ACP spawn exists; port forwarding and later native-tool/MCP parity remain open.                                                                                                                                                          |
| [Advisor strategy](plans/advisor-strategy.md)                                     | Active                           | [#566](https://github.com/copse-dev/agent-pane/issues/566), pack PR #1090, billing PR #918                                     | #566 is closed and the pack extraction merged. Any remaining billing or productization work needs its current PR/issue state checked separately.                                                                                                              |
| [Background task supervisor](plans/background-supervisor.md)                      | Active (P1)                      | [#1081](https://github.com/copse-dev/agent-pane/issues/1081)                                                                   | #1081 is open. The design and P1 schema/reconciliation helpers shipped; durable execution and recovery remain.                                                                                                                                                |
| [Command sandboxing routing](plans/command-sandboxing-routing.md)                 | Resolved                         | PR #700                                                                                                                        | Core scope is resolved; later permission modes and auditing are separately owned.                                                                                                                                                                             |
| [Copse cloud workspaces](plans/copse-cloud-workspaces.md)                         | Proposed                         | None                                                                                                                           | SSH and remote-e2e prerequisites exist, but the app-level provision/attach workflow has no dedicated tracker.                                                                                                                                                 |
| [Dark-factory PR orchestrator](plans/dark-factory-pr-orchestrator.md)             | Proposed                         | Design PR #960                                                                                                                 | The decision record exists; implementation has no dedicated issue.                                                                                                                                                                                            |
| [Demo links](plans/demo-links.md)                                                 | Active                           | PRs #986 and #989                                                                                                              | The plan and renderer spike are recorded. Confirm the current preview/distribution owner before scheduling more work.                                                                                                                                         |
| [Demo links: per-PR previews](plans/demo-links-per-pr-previews.md)                | Active                           | Plan document                                                                                                                  | The implementation boundary is documented, but production sign-off and follow-through have no dedicated issue in the ledger.                                                                                                                                  |
| [Execution runtime security](plans/execution-runtime-security.md)                 | Proposed                         | None                                                                                                                           | This is a cross-runtime contract with no implementation owner.                                                                                                                                                                                                |
| [Feature-pack marketplace](plans/feature-pack-marketplace.md)                     | Proposed                         | [#1082](https://github.com/copse-dev/agent-pane/issues/1082)                                                                   | #1082 is open. New behavior-pack issue [#1336](https://github.com/copse-dev/agent-pane/issues/1336) should be treated as a related slice, not a replacement for lifecycle ownership.                                                                          |
| [Grok Build architecture comparison](plans/grok-build-architecture-comparison.md) | Proposed                         | Existing subsystem issues                                                                                                      | The comparison maps dependencies, but its missing product-level contracts still need explicit owners where they are intended backlog.                                                                                                                         |
| [Hooks and feature packs](plans/hooks-and-feature-packs.md)                       | Active                           | Phase PRs through P11                                                                                                          | P1–P11 are on `main`. Future pack behavior should use a new scoped tracker rather than reopening the historical phases.                                                                                                                                       |
| [Industry benchmarks](plans/industry-benchmarks.md)                               | Active                           | [#752](https://github.com/copse-dev/agent-pane/issues/752)                                                                     | #752 is open. The newer real-agent-path and study-quality issues sharpen the remaining release-quality gap.                                                                                                                                                   |
| [Knowledge store](plans/knowledge-store.md)                                       | Active                           | [#645](https://github.com/copse-dev/agent-pane/issues/645)                                                                     | #645 is closed. The OKF store and migrations shipped; any remaining surfacing work needs a new or confirmed owner.                                                                                                                                            |
| [Long-horizon tasks](plans/long-horizon-tasks.md)                                 | Active                           | [#558](https://github.com/copse-dev/agent-pane/issues/558)                                                                     | #558 is open. Pack extraction shipped, while reliable long-lived execution depends on the supervisor.                                                                                                                                                         |
| [Markdown renderer hardening](plans/markdown-renderer-hardening.md)               | Superseded                       | `@copse/streaming-markdown`                                                                                                    | Correctly owned upstream; keep local work limited to integration regressions.                                                                                                                                                                                 |
| [Model classifier](plans/model-classifier.md)                                     | Active                           | [#557](https://github.com/copse-dev/agent-pane/issues/557)                                                                     | #557 is open. The scaffold exists; cost-aware selection and eval evidence remain.                                                                                                                                                                             |
| [Model roles and defaults](plans/model-roles-and-defaults.md)                     | Active                           | Phase PRs through #1018                                                                                                        | Backend foundations shipped. Generalized download UI and light evals have no dedicated issue in the ledger.                                                                                                                                                   |
| [Orchestration strategy](plans/orchestration-pattern.md)                          | Resolved                         | PR #969                                                                                                                        | The experimental scaffold is complete; refinements are separate follow-ups.                                                                                                                                                                                   |
| [Plan Mode and rewind](plans/plan-mode-and-rewind.md)                             | Proposed                         | [#1080](https://github.com/copse-dev/agent-pane/issues/1080)                                                                   | #1080 is open. The contract is design-only.                                                                                                                                                                                                                   |
| [Provider host allow-list](plans/provider-host-allowlist.md)                      | Resolved                         | [#438](https://github.com/copse-dev/agent-pane/issues/438)                                                                     | #438 is closed and the policy/UI shipped. Recent modal fixes are maintenance, not missing architecture.                                                                                                                                                       |
| [Release-readiness milestone 2](plans/release-readiness-milestone-2.md)           | Proposed portfolio               | Milestone 2 issues                                                                                                             | Several items closed after the 2026-07-21 ledger audit; the reconciled issue table below is the current planning input.                                                                                                                                       |
| [Remote e2e development loop](plans/remote-e2e-dev-loop.md)                       | Resolved                         | PRs #972 and #980                                                                                                              | M0–M4 and registry-backed startup shipped. Treat runner reliability fixes as operations work.                                                                                                                                                                 |
| [Roadmap plans](plans/roadmap-plans.md)                                           | Resolved core; follow-ups active | [#556](https://github.com/copse-dev/agent-pane/issues/556)                                                                     | #556 is closed and the pack extraction shipped.                                                                                                                                                                                                               |
| [Screen capture and remote video](plans/screen-capture-and-remote-video.md)       | Proposed                         | Video-frames PR #1227 as prerequisite                                                                                          | #1227 shipped attachment analysis. Capture, remote streaming, and SSH byte-read correctness have no dedicated issue in the ledger.                                                                                                                            |
| [Settings transparency](plans/settings-transparency.md)                           | Active                           | [#639](https://github.com/copse-dev/agent-pane/issues/639) plus adapter PRs                                                    | #639 is open. Sources/instruction parity shipped, but Claude hooks/settings parity remains.                                                                                                                                                                   |
| [SSH remote repositories](plans/ssh-remote-repo.md)                               | Resolved core                    | [#771](https://github.com/copse-dev/agent-pane/issues/771), ACP plan                                                           | The workspace stack and ACP-over-SSH Phase 1 shipped. Port forwarding and indexing limitations remain separate.                                                                                                                                               |
| [System-prompt context audit](plans/system-prompt-context-audit.md)               | Proposed findings                | PR #1292                                                                                                                       | The audit is on `main`; it deliberately made no prompt changes. Its per-capability prompt follow-up has no dedicated issue in the ledger.                                                                                                                     |
| [Terminal file links](plans/terminal-file-links-improvements.md)                  | Partial / deferred               | PR #415                                                                                                                        | File links shipped. Cwd-aware resolution remains explicitly deferred without a dedicated tracker.                                                                                                                                                             |
| [Thread referencing](plans/thread-referencing.md)                                 | Resolved core                    | [#644](https://github.com/copse-dev/agent-pane/issues/644)                                                                     | #644 is closed. The filesystem-native store shipped; newer loading/append work improves it without reopening the core issue.                                                                                                                                  |
| [Per-thread worktrees](plans/thread-worktrees.md)                                 | Active                           | [#869](https://github.com/copse-dev/agent-pane/issues/869)                                                                     | #869 is open. The implementation stack, UI routing, and branch-drift recovery have advanced, but end-to-end closure evidence is still required.                                                                                                               |

## Release-readiness issue reconciliation

The milestone plan was audited on 2026-07-21. Live GitHub state on 2026-07-29 is:

| Item                                                                                      | Live state       | Reconciled evidence                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [#607 ACP permission modes](https://github.com/copse-dev/agent-pane/issues/607)           | Closed           | Closed 2026-07-22; do not schedule it as unimplemented without a new regression.                                                      |
| [#830 ACP warm-session resume](https://github.com/copse-dev/agent-pane/issues/830)        | Closed           | Closed 2026-07-22; remaining adapter compatibility belongs in a follow-up.                                                            |
| [#832 ACP Tier-2 probes](https://github.com/copse-dev/agent-pane/issues/832)              | Open             | Still owns real-adapter behavioral evidence.                                                                                          |
| [#785 longer `run_shell` timeouts](https://github.com/copse-dev/agent-pane/issues/785)    | Closed           | Closed 2026-07-21.                                                                                                                    |
| [#787 pipeline exit masking](https://github.com/copse-dev/agent-pane/issues/787)          | Closed           | Closed 2026-07-21.                                                                                                                    |
| [#993 move `llm-history`](https://github.com/copse-dev/agent-pane/issues/993)             | Closed           | PR #1133 moved history into thread sidecars; the one-time migration was later removed after its support window.                       |
| [#998 catalog/lazy thread loading](https://github.com/copse-dev/agent-pane/issues/998)    | Open             | Off-main-thread loading and append hot-path improvements reduce cost, but do not by themselves prove catalog/lazy renderer hydration. |
| [#995 main-loop watchdog](https://github.com/copse-dev/agent-pane/issues/995)             | Closed           | Closed 2026-07-22; startup-budget reporting later added boot-complete evidence.                                                       |
| [#994 aged-profile startup e2e](https://github.com/copse-dev/agent-pane/issues/994)       | Open             | Still the integrated regression gate for realistic persisted profiles.                                                                |
| [#806 artifact-size budget](https://github.com/copse-dev/agent-pane/issues/806)           | Open             | No replacement owner found in the recent merged history.                                                                              |
| [#795 semantic-index scale guard](https://github.com/copse-dev/agent-pane/issues/795)     | Open             | No replacement owner found in the recent merged history.                                                                              |
| [#623 ACP client-owned terminals](https://github.com/copse-dev/agent-pane/issues/623)     | Open             | ACP transport exists; safe client-owned shell lifecycle remains a distinct high-risk boundary.                                        |
| [PR #840 audit-trail draft](https://github.com/copse-dev/agent-pane/pull/840)             | Closed, unmerged | It is not closure evidence for the audit trail. Use #656 and newer scoped implementation slices.                                      |
| [#656 durable permission audit trail](https://github.com/copse-dev/agent-pane/issues/656) | Open             | Still owns complete correlated, redacted, durable authorization evidence.                                                             |

## Recent merged evidence since the plans audit

### Thread storage, loading, and startup

- [PR #1133](https://github.com/copse-dev/agent-pane/pull/1133) moved `llm-history` out of
  `electron-store` into thread sidecars, closing #993.
- [PR #1184](https://github.com/copse-dev/agent-pane/pull/1184) stopped cloning whole histories on
  every stream chunk; [PR #1256](https://github.com/copse-dev/agent-pane/pull/1256) extended the same
  fix to subagent streams; [PR #1280](https://github.com/copse-dev/agent-pane/pull/1280) indexed
  message lookup and made append updates O(1) in place.
- [PR #1211](https://github.com/copse-dev/agent-pane/pull/1211) moved thread loading off the main
  thread. This is strong performance evidence, but it is not automatically complete acceptance for
  #998's catalog/lazy-loading scope.
- [PR #1213](https://github.com/copse-dev/agent-pane/pull/1213) deferred and parallelized startup
  probes, while [PR #1221](https://github.com/copse-dev/agent-pane/pull/1221) added startup-budget
  reporting. #994 remains the realistic-profile regression gate.

### ACP and SSH

- [PR #1202](https://github.com/copse-dev/agent-pane/pull/1202) shipped opt-in ACP agent spawn over
  SSH, so remote ACP is no longer a missing transport.
- [PR #1270](https://github.com/copse-dev/agent-pane/pull/1270) applied the project sandbox to Cursor
  ACP agents, and [PR #1340](https://github.com/copse-dev/agent-pane/pull/1340) kept shell approval
  prompts open until the user answers.
- [PR #1250](https://github.com/copse-dev/agent-pane/pull/1250) honored permission-RPC cancellation
  on Stop, while later disconnect and startup-probe fixes improved adapter resilience.
- The remaining release question is parity and conformance across real adapters: #623, #832, #771,
  and settings parity #639.

### Worktrees and branch recovery

- [PR #1273](https://github.com/copse-dev/agent-pane/pull/1273) routed task UI surfaces to thread
  worktrees.
- [PR #1276](https://github.com/copse-dev/agent-pane/pull/1276) adopted the live worktree branch when
  stored metadata drifted.
- [PR #1278](https://github.com/copse-dev/agent-pane/pull/1278) resolved the default branch from
  local `origin/HEAD` rather than assuming it.
- These changes materially advance #869, but the issue should close only with lifecycle, deletion,
  conflict, and restart evidence.

### Project automations and the durable supervisor

- [PR #1260](https://github.com/copse-dev/agent-pane/pull/1260) introduced a project-scoped cron
  automation prototype.
- [PR #1281](https://github.com/copse-dev/agent-pane/pull/1281) fixed scheduled automations so they
  actually start agent turns.
- [PR #1303](https://github.com/copse-dev/agent-pane/pull/1303) delivered the P1 supervisor task
  schema and pure reconciliation helpers.
- #1081 remains the durable owner for crash/restart reconciliation, monitoring, and long-lived task
  execution; the prototype and startup fix do not complete that contract.

### Video analysis versus capture

- [PR #1227](https://github.com/copse-dev/agent-pane/pull/1227) shipped attachment-based video
  analysis by reading videos as distinct stills rather than forwarding unsupported video payloads.
- [Screen capture and remote video](plans/screen-capture-and-remote-video.md) proposes a different
  scope: capture from simulators/emulators/remote hosts and stream binary data over SSH. That work is
  not implemented merely because attachment analysis exists.

### Prompt and evaluation quality

- [PR #1292](https://github.com/copse-dev/agent-pane/pull/1292) audited the system prompt against
  current context-engineering guidance. It records findings; it intentionally does not implement a
  per-capability prompt.
- SkillsBench work added paired checkpoint profiles (#1210), fixed checkpoint output policy
  (#1240), and made trials more interpretable (#1238).
- The newer open cluster—[#1272](https://github.com/copse-dev/agent-pane/issues/1272),
  [#1313](https://github.com/copse-dev/agent-pane/issues/1313) through
  [#1317](https://github.com/copse-dev/agent-pane/issues/1317), and
  [#1309](https://github.com/copse-dev/agent-pane/issues/1309) through
  [#1311](https://github.com/copse-dev/agent-pane/issues/1311)—correctly keeps the release-quality
  gap open: benchmarks must exercise the product agent path and produce interpretable evidence.

## Newly visible issue clusters

The newest open issues are mostly coherent follow-up programs rather than isolated bugs:

- **Real-agent evaluation path:** #1272, #1309–#1311, #1313–#1317, and diagnostic site #1320.
- **Type-safety hardening:** #1322–#1327, #1330, and #1332. These have dedicated issue ownership and
  should not be folded into unrelated feature PRs.
- **Feature-pack behavior isolation:** #1336, related to but narrower than marketplace lifecycle
  owner #1082.
- **Prompt-cache stability:** #1286, which complements recent stable-prefix work without replacing
  the startup and persisted-profile owners.

## Tracking gaps

Before filing any issue, search GitHub again to avoid duplicating a tracker created after this
snapshot. As of the plans ledger and live issue review, these scopes do not have a dedicated owner:

| Unowned or weakly owned scope                                         | Recommended boundary                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Copse-managed cloud provision/attach workflow                         | One product issue covering provisioning state, credentials, attach/recovery, and deletion.       |
| Shared execution-runtime security contract                            | Split implementation only after the common capability and audit model has an owner.              |
| Dark-factory PR orchestrator implementation                           | One issue for the first off-by-default vertical slice; keep the design PR as rationale.          |
| Per-PR demo preview production sign-off                               | One release/operations issue, separate from renderer feature work.                               |
| Knowledge-store surfacing after closed #645                           | One scoped discovery/read UX issue if the work is still desired.                                 |
| Generalized model download UI and light evals                         | Separate UI and evaluation owners; do not leave them as an indefinite tail on a historical plan. |
| Screen capture, remote video streaming, and SSH byte-read correctness | File the byte-read correctness bug independently from capture UX and streaming transport.        |
| Per-capability system prompt following #1292                          | One measured prompt-change issue with provider-specific acceptance evidence.                     |
| Cwd-aware terminal file-link resolution                               | One focused correctness issue if no existing tracker is found.                                   |

## Planning rule

Use this order when converting the audit into work:

1. Close or correct stale ledger entries where live issues are already closed.
2. Finish open release-readiness owners with acceptance evidence before inventing replacement plans.
3. Attach newly merged evidence to the owning issue; do not infer closure from an adjacent PR.
4. File one dedicated tracker for each intentional gap above, or mark the gap explicitly deferred.
5. Re-run the issue-state reconciliation before the next release planning pass.
