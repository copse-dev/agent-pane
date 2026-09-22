# Copse shipping quality assessment — 20 September 2026

Copse has a substantial engineering system for agent-led development. Its strongest areas are implementation discipline, deterministic tests, architectural boundaries, and release packaging. Its weakest areas are proving that required checks actually authorize a merge, independently challenging an agent's assumptions, and keeping product/release evidence current.

The next improvement should be to make the existing definition of done executable. Adding more general instructions or another broad planning document would have less value than closing the already identified acceptance gaps.

The [implementation roadmap](plans/sdlc-improvement-roadmap.md) ranks the work by complexity and defines delivery slices, dependencies, and acceptance criteria.

## Scope and confidence

This is an evidence-based process assessment, not a penetration test or a fresh certification of the application.

- The supplied checkout is `a5c52dac6` from 25 July. I initially inspected it, then reviewed a separate, read-only source snapshot of current `origin/main`: **`0a7a0967002da98b6055dc9f87544e91c8ad501b`**, also verified against live GitHub on 20 September. Findings below refer to that newer revision.
- Evidence includes agent instructions, plans, architecture tests, test configurations, CI and release workflows, support/recovery policies, live effective GitHub rules, open issues, public releases, and sampled workflow/review history.
- I inspected 100 recent CI runs, the latest 20 scheduled CI runs, and formal review records for four merged PRs. These are bounded samples, not a complete history or a statistical flake study.
- I did not run the application, spend model tokens on evaluations, install dependencies, change GitHub settings, or reproduce the suspected merge bypasses. Source/configuration observations and live outcomes are distinguished below.
- Existing informal human reviews, private test results, and organization-level configuration may provide evidence not visible in this assessment. An absent GitHub assignee does not prove that work has no human owner.

## Lifecycle assessment

| Stage                                | What is working                                                                                                                     | Main improvement                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Problem discovery and prioritization | Problem-oriented issue forms; area/priority labels; plans linked to trackers                                                        | Give the small active backlog explicit acceptance outcomes, accountable owners, and capacity limits                          |
| Requirements and design              | Written product definition of done; decision records; threat model; binding subsystem contracts                                     | Carry those decisions into each change's acceptance evidence and release decision                                            |
| Agent implementation                 | Concise `AGENTS.md`; progressive links to specialist guidance; edit hooks; strict type rules; prohibition on test-only product APIs | Standardize a short task brief and evidence-bearing handoff so agents do not invent completion criteria after implementation |
| Architecture and maintainability     | Package separation, import-direction tests, Electron boundary lint, dead-code checks                                                | Refactor measured change hotspots in small slices; keep experiments explicitly outside supported release scope               |
| Verification                         | Unit/component/browser/Electron tiers, test oracle, coverage floor, visual evidence, benchmark infrastructure                       | Restore missing runtime acceptance paths and measure the reliability of the full-suite safety net                            |
| Review and integration               | PR-only rules, required `CI Passed`, separate fork check context, screenshot review PRs                                             | Close gate bypasses and require independent review in proportion to risk                                                     |
| Security and dependencies            | Threat model, permission tests, secret/dependency gates, CodeQL, documented residual decisions                                      | Give security findings durable triage and make current security evidence part of stable-release authorization                |
| Release and distribution             | Separate promotion, signing, publication; exact commit/artifact checks; two architectures; package size budgets                     | Tie publication to a current candidate evidence record, including real upgrades and product-quality checks                   |
| Support, recovery, and learning      | Issue intake, privacy-conscious support policy, explicit backups and forward recovery                                               | Rehearse recovery, clarify beta support, and turn escaped defects into a small set of process metrics and regressions        |

Sources: [agent guidance], [testing strategy], [definition of done], [module boundaries], [release checklist], [support], [recovery].

## Strengths worth preserving

The repository is well beyond merely asking agents to “write tests.” It specifies which tier belongs to which failure, rejects empty test selections, distinguishes mock protocol coverage from real adapter behavior, and requires visual evidence for visible changes. There are **956 `.test.ts` files, 264 Electron `.e2e.ts` files, and 22 browser `.demo.ts` files** in the audited tree. These are inventory counts, not a claim of effective coverage or that every file runs in CI. The committed line-coverage floor is **73.04%**; that is a threshold, not a fresh measured result. [Testing strategy][testing strategy], [coverage gate].

Agent-specific failure modes have already influenced the design: type suppressions must remain empty; tests must not create unsupported product API; exceptions to architectural boundaries have reasons and stale-exception checks; oracle uncertainty broadens validation. These are useful executable constraints that should remain close to the code. [Agent guidance][agent guidance], [module boundaries].

The release pipeline has meaningful provenance controls. It builds from a verified candidate, signs/notarizes and smoke-tests each architecture, enforces size limits, assembles checksums, and publishes the tested bytes through a separate manually dispatched workflow. Public beta.7 and beta.8 releases exist; beta.8 was published on 29 August. This is demonstrated beta distribution, not yet evidence of stable GA completion. [Release build][release build], [publisher], [public beta.8].

## Prioritized findings

### 1. Make the required merge check unambiguously fail closed — highest priority

**Observed:** `CI Passed` is the required GitHub status. The aggregate job uses `if: !cancelled()`, and the workflow explicitly records the consequence that cancellation can leave the required job skipped and satisfy protection. This is already tracked as open GA blocker [#2520]. Effective branch rules also have `strict_required_status_checks_policy: false`.

**Additional source-level concern to validate:** stacked PRs can run a subset of unit tests without the coverage gate. The workflow assumes retargeting the PR to trunk reruns the full tier, but its `pull_request.types` does not include `edited`. A base-only retarget therefore has no explicit trigger here. This is a configuration gap, not a bypass I reproduced against GitHub.

**Why it matters for agents:** every instruction to wait for green CI depends on “green” proving the expected tests ran for the change being merged. A sophisticated test suite cannot compensate for an ambiguous authorization check.

**Action:** finish #2520; define required outcomes by event, base branch, head SHA, and base SHA in a small tested policy. Separate superseded-run cleanup from evidence that authorizes merging. Explicitly revalidate base changes. Select an up-to-date-base or merge-queue policy after evaluating current repository capabilities and throughput.

**Closure evidence:** integration cases for manual cancellation, supersession, draft-to-ready, stacked-to-trunk retarget without a push, base advancement, fork-to-maintainer transfer, and screenshot-only commits. Each must demonstrate that an untested candidate cannot satisfy the required gate. Preserve the current fork/self-hosted trust boundary. [CI workflow][CI workflow], [main rules].

### 2. Add independent acceptance review for high-risk changes — high priority

**Observed:** the main ruleset requires **zero** approving reviews, no code-owner review, no last-push approval, and no resolved review threads. Formal review endpoints returned no reviews for sampled merged PRs [#2681], [#2698], [#2700], and promotion [#2687]. This does not exclude informal review or review performed within an agent task. Organization admins and a configured integration can bypass the main ruleset.

**Risk:** one agent can interpret the requirement, implement it, write a test asserting that interpretation, and declare completion. Passing author-written tests does not independently establish that the user requirement or security boundary was correct.

**Action:** use a small risk classification. Permission/security changes, persistence/migrations, provider billing/authentication, CI authorization, and release machinery need a reviewer other than the implementation run plus an accountable human decision. Routine low-risk changes can retain a fast path. An independent agent review can supply evidence, but should not be represented as human approval. Review changes to test exclusions, coverage baselines, fixtures, and gate logic as changes to assurance itself.

**Closure evidence:** a high-risk PR cannot merge without recorded acceptance; subsequent material edits invalidate that acceptance; bypasses are narrow and auditable. Add a short PR evidence template: outcome, risk, independent check, exact validation, residual limitations. [Main rules][main rules], [agent guidance].

### 3. Restore the full-suite safety net and put limits on quarantine — high priority

**Observed:** the latest 20 scheduled CI runs, 1–20 September, ended **11 successful, 6 failed, 3 cancelled**. The two latest runs stopped at precheck, so no unit/build/e2e verification followed. The 20 September log shows a high-severity `adm-zip` dependency audit failure. That gate correctly rejected the dependency tree; this is not evidence of test flakiness. The later current-main push was green, so the earlier nightly result is not a claim that current main still fails.

**Observed:** `wdio.ci.conf.ts` explicitly excludes 12 specs, with additional `describeSkipInCi` cases. Full scheduled selection does not override these exclusions. Approval-path tests, including Guarded YOLO, remain quarantined under [#1680]. The issue cautions that they may be detecting a real fault; do not assume all session deaths are infrastructure noise. Unit policy tests still exist, so this is a gap in integrated runtime evidence, not absence of all safety tests.

**Action:** prioritize reinstating security-sensitive runtime cases. Give each quarantine an issue, accountable owner, date, compensating test, and expiry. Restore ordinary DOM checks at lower tiers where appropriate. Alert on loss of recent successful full-suite evidence, distinguishing dependency findings, infrastructure failures, product failures, and superseded runs. Keep dependency failure blocking while allowing independently isolated diagnostic tests to produce evidence where safe.

**Closure evidence:** required approval-path scenarios execute successfully on the intended runtime; release reports enumerate every excluded scenario and active waiver; full-suite evidence has an agreed freshness limit. [CI exclusions], [nightly failure], [last successful sampled nightly], [current-main CI].

### 4. Make real product quality a release criterion — high priority

**Observed:** deterministic coverage is extensive and benchmark methodology is thoughtful. However, [#1370] (production-boundary contracts), [#1371] (release-level agent quality), [#994] (aged-profile startup), and [#1369] (accessibility) remain open. The successful 18 September nightly skipped all four real-model jobs. `LM_EVAL_RUNNER` was absent from repository variables; organization settings or separate manual runs were not comprehensively audited. This establishes a gap in the sampled release-evidence path, not that real-model evaluation never occurs.

**Risk:** mocks encode expected adapter behavior; pristine fixtures miss accumulated state; screenshots do not establish keyboard/screen-reader usability; benchmark success can diverge from the shipped permissions and agent construction path. The project already recognizes these distinctions.

**Action:** implement the existing issues as a small candidate acceptance lane. Use representative real provider/ACP/MCP/SSH contracts, an aged profile across restart and upgrade, a few actual agent tasks, and essential accessibility journeys. Keep third-party variability outside ordinary PR gates, but require recent candidate-relevant evidence before release. Declare task/model versions, repeats, cost/latency/safety criteria, and waiver rules before running. Reuse existing paired/trial-manifest machinery.

**Closure evidence:** a candidate record links immutable results from the shipped product path; degraded auth, cancellation, unavailable capabilities, and recovery are covered; failures have disposition and expiring exceptions. Useful existing owners also include [#832] and [#1272]. [Testing strategy][testing strategy], [CI workflow], [steer evals].

### 5. Connect release permission to current readiness evidence — high priority before stable GA

**Observed:** the security ledger is reviewed through 28 August and says GA sign-off is not granted. Its listed live GA blockers are #507 and #802; the live open set on 20 September is **#802, #2478, #2507, and #2520**. The product definition-of-done audit is a clearly dated 29 July snapshot. Release attestation documents in this tree stop at beta.6, while beta.7 and beta.8 are public.

**Observed:** the publisher validates artifact provenance, checksums, successful source run, and release ancestry. I found no machine-checked candidate security sign-off, GA-blocker reconciliation, or acceptance-waiver input in the release workflows. Manual dispatch is a real owner-controlled step, but by itself does not bind those decisions to evidence.

**Action:** require one compact candidate manifest before publication: candidate SHA, artifact/source-run IDs, channel, completed acceptance results, current security review, blocker dispositions, expiring waivers, and owner decision. Apply stable-GA rules to stable releases; allow explicitly documented beta scope. Update a single current register and retain historical audits as snapshots rather than rewriting their history.

**Closure evidence:** stale or mismatched manifests, expired waivers, and unresolved stable blockers reject stable publication; accepted public install and update rehearsals are linked. Finish existing [#802] rather than creating a duplicate release program. [Security ledger][security ledger], [release checklist], [publisher], [public beta.8].

### 6. Turn security scan output into durable decisions — medium priority

**Observed:** CodeQL runs after main pushes and weekly, deliberately outside the required PR gate. It uses `upload: false` and retains SARIF artifacts for seven days. A successful scan job proves the analyzer ran; it does not prove findings were reviewed or accepted. I found no corresponding mandatory disposition step in the publication workflow.

**Action:** retain a durable finding register or use an enabled alert backend, with severity, owner, candidate impact, disposition, and review expiry. Ensure new material findings reach the release decision. Preserve the existing required secret/dependency checks. Treat workflow/action dependencies and native download provenance as part of the same ownership process.

**Closure evidence:** a seeded finding reaches triage, remains discoverable beyond artifact retention, and cannot disappear from the release decision merely because its workflow was green. This does not require making every informational scan result a merge blocker. [CodeQL workflow][CodeQL workflow], [CI workflow], [security ledger].

### 7. Reduce planning drift and improve agent handoffs — medium priority

**Observed:** there are 85 top-level plan documents and an existing product definition of done. The feature form asks for the problem, proposal, area, and related plans, but not explicit acceptance evidence. There is no PR template in the inspected `.github` tree. Live inventory contains 194 open issues and 16 open PRs; 182 issues have no assignee. For a small project that count is not inherently unhealthy, but it is insufficient to identify the next accountable delivery commitments.

**Action:** keep one small active delivery queue, each item with a problem, acceptance examples, risk/boundaries, owner, and next evidence-producing step. Explicitly distinguish active commitments from ideas and archived rationale. Give agents a brief that identifies the base revision and applicable contracts, then require a handoff that names the exact result, tests, unresolved assumptions, and remaining work. Reconcile linked issue state when an item starts and when it closes.

**Closure evidence:** a sample of completed tasks traces from user problem to acceptance check to merged change and observed result. Failed or partial work is not closed by an adjacent implementation PR. Avoid making every speculative plan pass a heavyweight project-management process. [Feature form][feature form], [definition of done], [plan ledger].

### 8. Close the support and learning loop — medium priority

**Observed:** the support policy deliberately provides no telemetry/crash reporting and no redacted diagnostic bundle. Raw thread exports can expose sensitive material. It also excludes prereleases, while the public releases currently visible are betas. Recovery is documented as backup plus a forward corrective release; that increases the importance of testing old-profile upgrades and restore behavior.

**Action:** state the actual beta support arrangement; provide an opt-in, locally previewable minimal diagnostic export; rehearse restoring representative profiles with credentials re-entered where necessary. Link escaped defects to their missing acceptance scenario and add the smallest regression that would have detected them. None of this requires adding automatic telemetry.

**Closure evidence:** a tester can report a useful redacted incident without manually auditing an entire conversation; a documented restore drill succeeds; serious regressions receive a short cause/prevention record. [Support][support], [recovery], [#994].

## Suggested implementation order

These are scoped work batches, not effort estimates or newly created issues.

1. **Trust the merge result:** #2520, retarget/base-change validation, and risk-based review. Run the gate adversarial cases before adding more automation around merging.
2. **Recover missing assurance:** #1680 and a quarantine register; establish recent full-suite evidence and a small CI-health report. Keep legitimate security failures blocking.
3. **Prove the candidate:** deliver narrow slices of #1370, #1371, #994, and #1369; make their outputs usable by the release manifest; reconcile #802 and the current GA blockers.
4. **Reduce future rework:** task/PR evidence templates, active-queue ownership, scan triage, beta support, and recovery rehearsal.

Preserve the existing architecture guards. Large modules such as `settings-dialog.ts` (4,615 lines), `conversation.ts` (3,483), and `register-handlers.ts` (3,115) are candidates for measured hotspot analysis, not justification for a broad rewrite. Likewise, the 1,986-line CI workflow and 916-line invariant test deserve a smaller explicit policy model, but correctness fixes should precede wholesale workflow refactoring.

## Measure outcomes, not instruction volume

Start with a small weekly report:

| Measure                                                            | Purpose                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Age of last successful full-suite run; excluded critical journeys  | Shows whether the fallback verification still provides useful evidence          |
| CI failures by cause, retries, and elapsed time                    | Separates product regressions from infrastructure and external-service failures |
| High-risk changes with independent acceptance                      | Measures the review control rather than counting generic reviews                |
| Rework or escaped defects by original acceptance gap               | Shows where agent-generated implementation/testing shared the wrong assumption  |
| Candidate requirements backed by current evidence; overdue waivers | Makes readiness inspectable without reading dozens of plans                     |
| Real-task completion, cost, latency, and safety on fixed workloads | Connects engineering checks to the quality of the shipped assistant             |

For context, the 100-run CI sample from 13–20 September contains 72 successes, 19 failures, and 9 cancellations; four runs have multiple attempts. Successful PR runs have a median creation-to-last-update interval of about 14.8 minutes. These are run-level observations: they are **not** first-pass pass rate, flake rate, compute cost, or developer lead time. Establish stable definitions before setting improvement targets.

The project already knows much of what good looks like. The highest-value work is making completion depend on current, independently inspectable evidence, then using failures to improve that evidence.

[agent guidance]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/AGENTS.md
[testing strategy]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/docs/testing-strategy.md
[definition of done]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/docs/product-definition-of-done-audit.md
[module boundaries]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/scripts/module-boundaries.test.ts
[coverage gate]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/scripts/coverage-gate.mts
[release checklist]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/docs/release-checklist.md
[release build]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/.github/workflows/release-mac.yml
[publisher]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/.github/workflows/release-publish.yml
[support]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/SUPPORT.md
[recovery]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/docs/recovery.md
[CI workflow]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/.github/workflows/ci.yml
[CI exclusions]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/wdio.ci.conf.ts
[CodeQL workflow]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/.github/workflows/codeql.yml
[security ledger]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/docs/security-review-ga.md
[feature form]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/.github/ISSUE_TEMPLATE/feature.yml
[plan ledger]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/docs/plans/README.md
[steer evals]: https://github.com/copse-dev/agent-pane/blob/0a7a0967002da98b6055dc9f87544e91c8ad501b/docs/steer-evals.md
[main rules]: https://github.com/copse-dev/agent-pane/rules/17887668
[public beta.8]: https://github.com/copse-dev/copse-releases/releases/tag/v0.1.0-beta.8
[nightly failure]: https://github.com/copse-dev/agent-pane/actions/runs/35507516170
[last successful sampled nightly]: https://github.com/copse-dev/agent-pane/actions/runs/35338330781
[current-main CI]: https://github.com/copse-dev/agent-pane/actions/runs/35515680415
[#2520]: https://github.com/copse-dev/agent-pane/issues/2520
[#1680]: https://github.com/copse-dev/agent-pane/issues/1680
[#1370]: https://github.com/copse-dev/agent-pane/issues/1370
[#1371]: https://github.com/copse-dev/agent-pane/issues/1371
[#994]: https://github.com/copse-dev/agent-pane/issues/994
[#1369]: https://github.com/copse-dev/agent-pane/issues/1369
[#832]: https://github.com/copse-dev/agent-pane/issues/832
[#1272]: https://github.com/copse-dev/agent-pane/issues/1272
[#802]: https://github.com/copse-dev/agent-pane/issues/802
[#2681]: https://github.com/copse-dev/agent-pane/pull/2681
[#2698]: https://github.com/copse-dev/agent-pane/pull/2698
[#2700]: https://github.com/copse-dev/agent-pane/pull/2700
[#2687]: https://github.com/copse-dev/agent-pane/pull/2687
