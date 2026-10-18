# Main gate shadow: first implementation slice

Base reviewed: main `911774a126d7471ab22b84357a84d97d17e6660f` on 16 October 2026.
The [shaping plan](main-gate-shaping.md) remains Proposed. Required checks, actual oracle
selection, exclusions, retry counts, release behavior and the `CI Passed` aggregate are unchanged.

## Evidence produced

After the existing plan step finishes (including its early-return paths), precheck preserves
its effective e2e and unit outputs, the runnable suite, candidate commit, PR head, base SHA,
event, draft/label/stack context, oracle confidence and reasons, smoke inventory, and advisory
selection. `selected-plan.json` is written before the shadow computation; it remains useful if
the shadow fails. `plan.json` adds the completed comparison and full selected spec lists.

Every CI WebdriverIO worker writes one JSON result per spec and outer attempt. It records
worker start-to-exit seconds, worker exit code and outcome, shard, candidate SHA, run ID and
run attempt. A launcher/session failure is a failed worker, with failure class `unclassified`.
A worker interrupted before exit retains `running`; specs never started are missing, and the
comparison lists them as incomplete. Worker success means the spec process exited successfully;
it does not establish that every test inside it ran (platform-skipped suites can exit green).
No error messages, transcripts or screenshots enter this small artifact.

Artifacts use run-attempt-specific names and upload with `always()`. They request 90 days of
Actions retention, but repository policy currently caps observed retention at five days.
The independent `Publish gate evidence` workflow receives completed CI runs, including failures
and cancellations. It checks out its trusted workflow revision, validates downloaded JSON as
data, binds outcomes to the plan's candidate/run/attempt, rejects duplicate attempts, and writes
a combined record under `ci-evidence/v1/<run>/<attempt>/<sha256>.json` in the existing screenshot
R2 bucket. Conditional creation and a downloaded digest check protect each object's contents.
Reruns retain earlier plan/shard artifacts from the same candidate for audit. Only outcomes from
the latest workflow attempt establish coverage: without trusted job-attempt metadata, an older
pass cannot distinguish an untouched successful shard from a rerun that never reached that spec.
Failed-jobs-only reruns can therefore remain incomplete; a complete rerun establishes coverage.
The public object link is posted in a neutral `Small gate (shadow)` check and workflow summary.
PR execution receives no R2 credentials and no job consumes the shadow outputs.

Publication failures remain visible in the independent workflow; Actions artifacts are the
recovery copy. This PR does not establish release attestation or make R2 immune to administrative
deletion. The publisher first becomes active after the workflow lands on main; its credentialed
live behavior cannot be proven by this PR's own first CI run.

## Selector and smoke ownership

The inventory contains exactly the plan's twenty seeds, all live, in the CI suite, outside the
exclusions inventory, and individually at most 15 seconds in committed shard weights. Their
combined committed median is about 175 seconds, before per-spec session overhead. They are:

`smoke`, `theme-boot`, `titlebar-icons`, `composer-surface`, `thread-sidebar-selection`,
`command-palette`, `file-search-palette`, `settings-save`, `appearance-settings`, `panel-position`,
`terminal-display`, `git-changes`, `markdown-conformance`, `tool-display-live-mock`,
`worktree-preparation`, `activity-panel`, `pr-panel`, `browser-display`, `new-project-flow`,
`acp-startup-tools` (all under `tests/e2e/`, ending `.e2e.ts`).

Ownership entries include an actual oracle selector/import reason from current main. Several
proposed directory names are flat modules in this tree; the inventory uses their actual paths.
Areas with no defensible reason, including the proposed main agent/git/terminal directories,
are explicitly null. Top-level service/view/package directories also have an ownership entry
or explicit null. The tests verify these boundaries and the cited reasons.

HIGH confidence selects affected CI specs plus smoke. LOW confidence expands every owned
unmapped area through the existing oracle's selector/import machinery. Any missing/null area,
unknown base, broad pattern, stack tip, release base, nightly, requested full/refresh run, or
selection above half the suite keeps full coverage. Package source conservatively stays full:
the current oracle does not include it in its e2e confidence universe. Docs-only changes skip.
The existing subset shard formula (four specs per shard, capped at eight) is used for estimates;
the twenty smoke specs alone therefore plan five shards, not the proposal's hoped-for two.

## First comparison

These are deterministic selector probes on the reviewed main tree, not historical run replays:

| Change                                           | Today's selection | Shadow selection              | Estimated spec-minutes saved |
| ------------------------------------------------ | ----------------- | ----------------------------- | ---------------------------- |
| This implementation (`wdio.ci.conf.ts` changes)  | full, 403 specs   | full, 403 specs               | 0.0                          |
| `src/renderer/styles/global/command-palette.css` | affected subset   | 32 specs: affected plus smoke | -3.0 (adds smoke)            |
| `src/renderer/markdown/code-block-copy.ts`       | affected subset   | 76 specs: affected plus smoke | -2.5 (adds smoke)            |
| `src/main/services/storage/settings.ts`          | full              | full, 403 specs               | 0.0                          |
| `docs/plans/main-gate-shaping.md`                | skip              | skip                          | 0.0                          |

The CI artifact and summary list every selected path. Estimates sum committed median spec
seconds plus the oracle's 1.3-second per-spec session overhead, with median fallback for new
specs; they also report the maximum duration-balanced shard load. They exclude runner setup,
downloads, retries and queues. They are neither measured job-minutes nor total CI wall-time
savings. This first slice establishes measurement, not a demonstrated reduction in full runs.

A recent actual failure was inspected in
[run 38847775396, shard 4](https://github.com/copse-dev/agent-pane/actions/runs/38847775396/job/116805244509):
`automation-trigger.e2e.ts` failed on both attempts (attempt 1 at line 389; attempt 2 expected
`3 runs`, received `4 runs` at line 308). The job tested PR #3688 head
`cbe18a14ac43559b8553ef4ed54631f1cb360836` merged into base
`4060d09334e2d8676085dc76fd1fbbbaa1a70059`. Its diff includes `src/main/index.ts`, a broad
pattern at that revision and today, so the shadow retains full and would run this failing spec.
There is no subsequent source push or closed-as-broken evidence establishing the plan's **real**
classification at observation time; it remains unclassified. This is one inspected run, not the
300-run replay, and establishes no population missed-real-failure rate. No real failure has
been demonstrated missed in this sample; the historical rate remains unknown.

## Replay and remaining evidence

Download a linked R2 record and run:

```sh
node scripts/replay-gate-evidence.mts record.json classifications.json
```

The optional classification file is an array of `{ "spec": "tests/e2e/example.e2e.ts",
"classification": "real", "evidence": "https://github.com/..." }` rows. `not-real` is the other
classification. A real classification needs evidence of the next shipped-source/spec push or
broken closure specified by the plan. A retry pass is reported separately; persistent failures
without cited classification stay unknown. A real miss requires both failed attempts and an
omitted spec. Missing/interrupted results prevent a complete classification claim. A failed
shadow calculation cannot be replayed as a zero-miss result.

The four-week live window, 300-run historical replay with run-time trees/base/labels, first-attempt
smoke pass rates, weekly/promotion comparisons and promotion attestation remain prerequisites
for any later gate reduction. No aggregate savings or zero-miss claim should be inferred before
those exist. Current median weights establish cost estimates only, not smoke reliability.

## Review follow-up (17 October 2026)

Release-branch and `v*` tag pushes now force the advisory full plan even for an
empty diff. Rerun comparisons use the source workflow attempt, including offline
replay, and report older-only observations as incomplete rather than silently
reusing a pass. This is conservative for failed-jobs-only reruns and does not
change required CI decisions.

Validation: 152 focused selector, publisher/replay, launcher and CI-gate tests
passed. All `check:local` stages passed. The separately completed full unit run
was non-green: 11,669 passed, 278 failed, 9 cancelled and 10 skipped. Failures
include unavailable native/runtime dependencies and process-lifecycle cases;
not every failure has been independently reproduced on the base. Hosted CI on
the updated head remains required. No live credentialed publication was tested.
