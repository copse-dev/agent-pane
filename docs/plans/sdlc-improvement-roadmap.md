# Shipping quality roadmap

Status: **Tracked in [#1373]; first implementation slices of R01–R03, R11 cancellation protection, and R12 runtime reinstatement have merged.** Adoption, exclusion cleanup, and the remaining merge controls are still open. Repository permission and merge-rule changes remain proposals.

Based on the [20 September 2026 shipping quality assessment](../sdlc-review-2026-09-20.md), which reviewed `main` at `0a7a0967002da98b6055dc9f87544e91c8ad501b` and live GitHub evidence. The document paths retain their original names so existing links keep working. Recheck the relevant source and issue before starting each item.

The objective is to make an agent's claim of completion traceable to a user outcome, trustworthy validation, independent review where warranted, and current release evidence. Preserve the existing test tiers, architecture guards, and packaging pipeline.

## How to read the ranking

**Complexity** combines implementation breadth, uncertainty, cross-system dependencies, and difficulty of proving the result. It is not severity, elapsed time, or an estimate of how quickly an agent can write the code. Items sharing a score are broadly comparable; ordering within a score is approximate.

| Score           | Meaning                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| 1 — Low         | Mostly documentation or workflow convention; bounded and easy to inspect                     |
| 2 — Moderate    | Small script or CI addition using existing data; limited integration                         |
| 3 — Substantial | Several components or trust boundaries; explicit design and integration validation           |
| 4 — High        | Runtime diagnosis, races, external integrations, or a broad acceptance matrix                |
| 5 — Very high   | Product-path integration plus experimental design and evidence gathered across repeated runs |

**Start** is the recommended scheduling priority: **Now** is the first engineering batch, **Next** follows the foundations, and **Later** can follow the critical assurance work. These are proposed priorities, not newly declared release policy. Dependencies below concern full enforcement; fixtures, schemas, and investigations can often start earlier.

## Work ranked from least to most complex

| Rank / ID | Work package                                                      | Complexity                        | Start                     | Main dependency / existing tracker                                   |
| --------- | ----------------------------------------------------------------- | --------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| R01       | Task briefs, PR evidence, and an owned active queue               | 1                                 | Now                       | Existing definition of done; [#2718] under [#1373]                   |
| R02       | Reconcile readiness records and clarify beta support              | 1                                 | Now                       | Live issue/release evidence; [#802]                                  |
| R03       | Give quarantined tests owners, expiry, and compensating evidence  | 2                                 | Now                       | Inventory and drift check [#2719]; complements [#1680]               |
| R04       | Make security findings durable and actionable                     | 2                                 | Next                      | Existing CodeQL/SARIF output; R02 for release linkage                |
| R05       | Report CI health and freshness of successful validation           | 2                                 | Now                       | Existing Actions data and R03                                        |
| R06       | Enforce independent acceptance of high-risk changes               | 3                                 | Now                       | R01; trusted enforcement choice; R11 for dependable required checks  |
| R07       | Require a candidate-specific release evidence manifest            | 3                                 | Next                      | R02; R11; consumes R03–R06 and R08/R09/R13/R14 as introduced; [#802] |
| R08       | Test aged profiles, upgrades, backup, and restore                 | 3                                 | Next                      | Existing seed/store harness; [#994]                                  |
| R09       | Add accessibility acceptance for core user journeys               | 3 initially; 4 for full scope     | Next                      | Existing visual fixtures; [#1369]                                    |
| R10       | Provide a minimal, safe support diagnostic export                 | 3 initially; 4 with in-app UX     | Later                     | R02 support contract; explicit diagnostic data schema                |
| R11       | Fix cancellation, retargeting, and stale-base merge authorization | 4                                 | Now — critical            | [#2520]; live GitHub behavior and rules                              |
| R12       | Diagnose approval-path session deaths and reinstate tests         | 4, highest diagnostic uncertainty | Now — critical            | Fresh reproduction; [#1680]; R03 records remaining exclusions        |
| R13       | Run representative real-integration contracts                     | 4                                 | Next                      | Test accounts/hosts and R05; [#1370], [#832]                         |
| R14       | Gate releases on quality of the actual shipped agent              | 5                                 | Next — begin design early | R13; product-path parity; [#1371], [#1272]                           |

**Do not implement in rank order.** R11 and R12 should start alongside the low-complexity foundations. They protect the validity of subsequent work and have the greatest potential to expand once investigated.

## Concrete delivery slices

### First implementation batch — 20 September 2026

- R01 / [#2718]: feature acceptance examples, PR evidence template, and task/handoff guidance. Adoption across five completed changes remains to be demonstrated.
- R02 / [#1373] and [#802]: [current release evidence](../product-release-evidence.md), historical security-review labelling, and latest-beta support wording. No candidate sign-off or new risk acceptance.
- R03 / [#2719]: [exclusion inventory](../../tests/e2e/exclusions.json) and `check:e2e-exclusions` in the local/CI precheck. Initial entries name responsible roles and a first review deadline; assignment to people, disposition, and enforcing expired critical waivers remain open. Existing exclusions and test selection are unchanged.
- R11 / [#2520]: inspection confirms the cancellation condition also has an intentional regression assertion in `scripts/ci-workflow-invariants.test.ts` guarding the old canceled-run queue stall. A condition-only patch is insufficient; the real-GitHub reproduction and authorization-state design remain separate work.

Use [#1373] as the delivery index, with existing domain issues retained as the source of their acceptance criteria. None of the larger roadmap packages closes merely because this first batch lands.

### Review update — 22 September 2026

- R01–R03: [#2720](https://github.com/copse-dev/agent-pane/pull/2720) merged the task/PR conventions, release evidence reconciliation, and exclusion inventory/checker. Its [full PR run](https://github.com/copse-dev/agent-pane/actions/runs/35671783008) passed all eight Electron shards; adoption and remaining exclusion dispositions stay open.
- R11: [#2722](https://github.com/copse-dev/agent-pane/pull/2722) merged the tested cancellation gate. Retarget-only validation, current-base enforcement, and independent acceptance remain separate work under [#2520] and R06.
- R11 base advancement: the `Base Current` check ([`ci-base-freshness.md`](ci-base-freshness.md)) re-evaluates every mergeable open pull request when its base moves, so a green `CI Passed` describing a superseded merge result is visible rather than silent. It is **advisory and must not be made a required check**: withdrawing an already-published `success` needs a successful POST to that head, and check runs have no expiry or bulk invalidation, so any failed or undispatched fan-out leaves authorizing successes on the heads it did not reach. Enforcement of the same property is a repository-settings choice GitHub evaluates at merge time — "Require branches to be up to date before merging" (plausibly on `release` only, for throughput) or a merge queue this plan cannot buy — and that choice is the open base-advancement work. Live Actions probes of the published check and independent acceptance (R06) also remain open under [#2520].
- R12: [#2731](https://github.com/copse-dev/agent-pane/pull/2731) restored all three approval suites and strengthened the shell-output assertion. The subsequent [scheduled full run](https://github.com/copse-dev/agent-pane/actions/runs/35601257564) at `16f1e9e67` passed all eight Electron shards. This establishes reinstatement on the current CI environment, not the cause of the historical runner failures.
- R03: review of [#2720](https://github.com/copse-dev/agent-pane/pull/2720) reproduced silent undercounting when a declared exclusion array was later mutated. The scanner now rejects mutations and escaped references, with regression coverage; the merged inventory recorded 19 specs and 24 markers. Personal ownership and expiry enforcement remain under [#2719].

### R01 — Task briefs, evidence, and active ownership

Add a short PR template and extend the feature intake with observable acceptance examples. Reuse the existing definition of done. The task brief names the problem, scope, risk, applicable contracts, base revision, and intended validation. The completion handoff names the result, exact validation evidence, unresolved assumptions, and residual work. Choose a small active queue with an accountable owner per item; leave speculative plans outside that queue.

**Done when:** the next five completed changes can be traced from problem to acceptance evidence and merged result, without reconstructing the agent conversation. Merely adding a template is the first slice, not proof that the workflow is adopted. **Owner role:** maintainer.

### R02 — Current readiness and beta support

Reconcile the live GA blockers, security review, public artifacts, and known issues into one current release register. Preserve older audits as dated history. Confirm which public beta receives support and how testers should report problems. Re-evaluate existing accepted risks against the candidate; do not copy acceptance dates forward without a decision.

**Done when:** the register names the current candidate/channel, each blocker and owner, missing evidence, and dated decisions; public support instructions agree with the release actually available. An unresolved issue is recorded rather than silently treated as closed. **Owner role:** release owner.

### R03 — Quarantine management

Inventory both configuration exclusions and in-spec skips. Record the reason, tracker, accountable owner, affected journey, date, review expiry, and compensating coverage. Separate platform-only tests from broken tests and intentional live-service exclusions. Add a small validation/reporting step so new unexplained exclusions cannot hide in a successful full run.

**Done when:** every intentional exclusion has a disposition; unrecorded exclusions and expired critical waivers fail the applicable acceptance gate. This does not itself repair #1680. **Owner role:** test infrastructure owner, with subsystem owners for each exclusion.

### R04 — Security finding disposition

Choose one durable destination: an available alert backend or a small versioned finding register. Give findings stable identities, severity, owner, first/last seen, disposition, and expiry where accepted. Import existing scan output and feed unresolved material findings into R07. Avoid a new dashboard until the data and ownership work.

**Done when:** a seeded test finding survives artifact expiry, reaches an owner, and appears in candidate readiness; rerunning the scan does not duplicate or silently erase it. A green analyzer job is distinguishable from a clean or accepted result. **Owner role:** security/release owner. Reassess the score if enabling the chosen backend needs organization changes or procurement.

### R05 — CI health and evidence freshness

Create a small report from Actions results: latest successful full-suite revision/time, missing journeys, first-attempt failures where available, retries, and failure categories. Start with manual classification for ambiguous failures. Define a freshness target from the actual cadence. Surface a meaningful failure or expiry once, without generating a new issue on every run.

**Done when:** a cancelled or precheck-only nightly never refreshes the full-suite success timestamp; dependency/security findings, infrastructure faults, test failures, and supersession are distinguished. Reporting stays separate from the authorization control in R11. **Owner role:** CI owner.

### R06 — Independent acceptance for high-risk changes

First classify security/permissions, persistence/migrations, authentication/billing, CI gates, and release machinery as requiring independent acceptance. Include reductions in test coverage or weakened baselines. Define the low-risk fast path. Then choose enforcement that works for the actual maintainer/author arrangement: another human reviewer, or a trusted acceptance check combining separate review evidence and explicit owner acceptance. Do not create a rule that makes a solo-maintainer workflow impossible.

Bind acceptance to the reviewed revision and invalidate it after material changes. An author-set label or an agent's self-attestation is insufficient. Keep privileged review enforcement separate from execution of untrusted PR code; retain narrow, recorded emergency overrides.

**Done when:** a high-risk sample change cannot merge without valid acceptance and loses that acceptance when its reviewed content changes. Record who reviewed, what they challenged, and which evidence they inspected. **Owner role:** maintainer plus independent reviewer. This roadmap specifies the control; it does not change repository permissions.

### R07 — Release evidence manifest

**Slice A:** define and validate the record early: candidate SHA, artifact digests/source run, channel, required checks, real-service/model versions where applicable, security disposition, exclusions/waivers with expiry, and accountable owner decision. Produce a readable summary from the same record.

**Slice B:** connect the validator to publication after the evidence producers exist. Validate trusted run results and immutable artifacts rather than accepting editable `passed: true` fields. Reject mismatched revisions and stale evidence. Where an integration result can legitimately carry across candidates, define the permitted reuse rule and require review of relevant intervening changes. Differentiate beta and stable requirements explicitly.

**Done when:** missing required evidence, a failed check, expired waiver, unresolved stable blocker, or wrong artifact prevents the applicable publication. A fully evidenced candidate publishes the already-tested bytes. Complete the update/install evidence under #802; do not rebuild that machinery. **Owner role:** release owner with CI support.

### R08 — Aged-profile upgrade and recovery

Generate a bounded synthetic profile with multiple projects, long threads, attachments, realistic stores, and a large workspace. Use current supported formats and supported upgrade paths; the historical #994 description contains legacy details that must be reconciled with today's code. Measure app-owned readiness and memory, not just WebDriver connection time. Exercise first migration boot and second steady-state boot.

Add an isolated backup/restore rehearsal and check representative data integrity, recovery from an interrupted write, and the documented credential re-entry behavior. Derive platform budgets from repeated measurements before enforcing thresholds.

**Done when:** both boots and a restore reach an interactive, usable thread without losing data; time/memory obey reviewed budgets; failures preserve useful diagnostics. Narrow fixture coverage first, then expand. **Owner role:** storage/runtime owner; tracker #994.

### R09 — Accessibility acceptance

Start with onboarding/model setup, the composer, approval dialogs, and thread navigation. Check keyboard use, focus order/restoration, names/roles, zoom, contrast, and reduced motion where applicable. Add a recorded screen-reader pass on supported macOS. Extend to Monaco, terminal, diffs, and complex markdown as later slices.

**Done when:** the named core journeys have repeatable automated checks plus dated assistive-technology evidence; discovered usability defects have fixes or explicit bounded disposition. Existing screenshots remain useful but are not the accessibility result. Full closure follows #1369's broader matrix. **Owner role:** renderer owner plus a human accessibility tester. The harness is easier than remediation of every defect it may uncover.

### R10 — Minimal diagnostics and support learning

Begin with an explicitly invoked local export of allow-listed facts: app/platform versions, bounded error identifiers, subsystem health, and relevant timestamps. Exclude prompts, source, tool arguments, credentials, and raw environment by construction. Let the user inspect the output before choosing to share it. Add a UI entry point only after the schema and redaction behavior are proven; it needs the usual focused visual evidence.

Pair serious support incidents with a short record of cause, missing acceptance check, and regression coverage. Reuse those records in the weekly health review.

**Done when:** seeded secrets and private paths do not appear in the export, a tester can produce a useful minimal report, and no data is automatically transmitted. **Owner role:** runtime/support owner. This is not a telemetry project.

### R11 — Trustworthy merge authorization

**First slice: prove the cases.** Reproduce #2520 and the audit's suspected base-retarget gap on disposable test branches or a test repository. Capture event, head/base revisions, run/check conclusions, and whether merging is allowed. Treat the retarget concern as unproven until tested.

**Second slice: fix the policy.** Define required outcomes for each event/tier and a tested state model. Separate cancellation of obsolete work from a successful authorization for the current candidate. Revalidate base-only retargets and choose a current-base/merge-queue policy suited to this repository. Keep the tiny authorization job independent of a saturated execution fleet. Do not fix the skipped-check case by reintroducing the old cancelled-run queue deadlock.

**Done when:** manual cancellation, supersession, draft-to-ready, retarget without a push, base advancement, fork transfer, and screenshot-only updates cannot authorize an untested candidate. Verify real GitHub behavior as well as unit policy tests; workflow-text assertions alone are insufficient. **Owner role:** CI owner plus independent reviewer; tracker #2520. Update rules and check names in a sequence that never opens an unprotected merge window.

### R12 — Approval-path crash diagnosis

Reproduce the quarantined cases on current source with fresh main/renderer/process logs and durable failure artifacts. Historical artifacts may have expired. Establish whether the failure is product lifecycle, process crash, sandbox interaction, or runner behavior before selecting a fix. Reuse the existing smallest failing specs; do not substitute more generous timeouts for diagnosis.

**Done when:** the failure has an evidenced cause, the fix has the lowest useful regression test, and the real approval/deny runtime scenarios execute in CI without quarantine or excessive retries. Repeat fresh sessions to establish stability, then run the normal full gate. **Owner role:** Electron/runtime owner; tracker #1680. Re-estimate after reproduction—this is the least predictable diagnostic item.

### R13 — Real production-boundary contracts

Start with one supported provider, one ACP adapter, and controlled MCP/SSH targets. Reuse #832's probes. Cover success and failure behavior: authentication, throttling, timeouts, cancellation, restart/resume where supported, unavailable capabilities, and permission/write routing. Declare what each fixture proves; a controlled test server cannot substitute for evidence from a supported external adapter.

Run on a schedule and for candidates in isolated environments with scoped credentials, token/runtime budgets, redacted results, and a named failure owner. Distinguish product regressions from service outages; neither should become an unexplained green result. Expand the matrix by supported exposure, not by connector count.

**Done when:** the first representative contracts produce immutable candidate-relevant evidence and failure dispositions consumed by R07; the full acceptance matrix remains explicit until covered. **Owner role:** provider/ACP integration owner with CI support; trackers #1370 and #832.

### R14 — Release-level agent quality

**Slice A:** identify the smallest way to exercise existing shipped agent construction, tool definitions, settings, and permission handling. Reconcile #1272 with current code before creating another entry point. A narrow release suite need not wait for migration of every historical benchmark.

**Slice B:** select representative tasks for repository changes, tool-heavy work, long conversations, cancellation/recovery, and safety boundaries. Record whether the task actually exercised its intended behavior. Pin task/model/configuration versions; set solve-quality, latency, cost, and safety criteria and rerun policy before evaluating the candidate.

**Slice C:** gather repeated baseline/candidate evidence, handle variance explicitly, and feed the accepted comparison into R07. Preserve established trial manifests and paired comparisons. Do not lower thresholds after a failed candidate simply to obtain a pass.

**Done when:** a real regression in the shipped agent path can reject a candidate, stochastic noise has a documented treatment, and results identify precisely which product modes and tasks they cover. **Owner role:** agent/evaluation owner plus an independent acceptance reviewer; trackers #1371 and #1272. This is the highest-complexity work because sound measurements and product parity matter as much as implementation.

## Recommended delivery sequence

| Milestone                                       | Work                                                                                        | Exit condition                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| M0 — Make work and evidence explicit            | R01/R02; R03 inventory; start R11/R12 reproduction immediately                              | An owned active queue, current readiness record, and reproducible or clearly bounded critical failures                               |
| M1 — Trust merge and runtime verification       | R11/R12 fixes; R03 enforcement; R05; R06                                                    | Required merge outcomes are proven; critical approval tests run; missing/stale evidence is visible; high-risk acceptance is enforced |
| M2 — Build candidate acceptance                 | R04; R07 schema/reporting; R08/R09; representative R13/R14 slices                           | The candidate produces useful security, recovery, accessibility, integration, and agent-quality evidence                             |
| M3 — Make publication consume that evidence     | R07 publication enforcement; complete #802 install/update rehearsal and blocker disposition | A valid candidate publishes tested artifacts; deliberately invalid evidence blocks publication                                       |
| M4 — Improve support and reduce repeat failures | R10; expand acceptance matrices; review rework and incident causes                          | Useful private-by-default diagnostics and a working defect-to-regression feedback loop                                               |

Milestones can overlap when they do not compete for the same workflow or runtime files. Keep CI authorization changes owned by one implementation stream; separate test fixtures can progress alongside it. The release-manifest schema can start early, but wiring an empty checklist into publication is not M3 completion.

For a small team, limit active work to one CI/control change, one runtime/test investigation, and lightweight evidence cleanup. Finish reviewable slices before opening more implementation fronts.

## First five proposed change sets

1. **Task and release records:** R01 plus the bounded R02 reconciliation; no product behavior changes.
2. **Quarantine inventory and validation:** R03, explicitly identifying #1680's critical journeys.
3. **Merge-gate correction:** R11, backed by reproduced GitHub cases; coordinate the required repository configuration changes.
4. **Independent acceptance and CI health:** implement R06 and R05 in separate small PRs if they touch different enforcement surfaces.
5. **Approval-path repair and reinstatement:** R12, after diagnostic evidence identifies the cause.

Start diagnosis for changes 3 and 5 immediately, rather than waiting for changes 1 and 2 to merge. Next prioritize R08 and a representative R13 contract, with R07's schema consuming their outputs; begin R14 study design in parallel with those foundations.

## Planning limits

- These are relative complexity estimates. Do not turn them into fixed dates until R11/R12 are reproduced and R13/R14's supported matrix is bounded.
- Assign actual people when scheduling each slice; an owner role in an inventory is not an assignment. GitHub tracking exists under #1373; monitors and branch/release rules are unchanged.
- Link implementation slices to the existing trackers. New scoped trackers are appropriate only where no current owner exists; do not recreate #2520, #1680, #994, #1369, #1370, #1371, or #802.
- Rebase implementation work onto current main. Before changing hooks or permission behavior, read the binding hooks/feature-pack and shell-permission guidance from that revision.
- Defer broad CI rewrites, replacement test frameworks, full benchmark migrations, and large-module refactors unless investigation proves they are needed for a specific acceptance result.

[#2520]: https://github.com/copse-dev/agent-pane/issues/2520
[#1680]: https://github.com/copse-dev/agent-pane/issues/1680
[#1370]: https://github.com/copse-dev/agent-pane/issues/1370
[#1371]: https://github.com/copse-dev/agent-pane/issues/1371
[#994]: https://github.com/copse-dev/agent-pane/issues/994
[#1369]: https://github.com/copse-dev/agent-pane/issues/1369
[#832]: https://github.com/copse-dev/agent-pane/issues/832
[#1272]: https://github.com/copse-dev/agent-pane/issues/1272
[#802]: https://github.com/copse-dev/agent-pane/issues/802
[#1373]: https://github.com/copse-dev/agent-pane/issues/1373
[#2718]: https://github.com/copse-dev/agent-pane/issues/2718
[#2719]: https://github.com/copse-dev/agent-pane/issues/2719
