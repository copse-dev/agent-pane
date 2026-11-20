# Exact branch history and CI reads

## Task brief

Real read-only Copse evals showed a model putting `main` in `git_log.path` (which means a file
filter) and getting no history. The tool has no revision selector. Workflow listing also mixes
branch CI with PR follow-up workflows, with no exact commit, workflow or event selectors.

Acceptance:

- Read history at a named commit/branch without checking it out. Keep file filtering separate.
- Reject invalid or option-like revisions, and preserve the working tree and current branch.
- Filter workflow runs by exact SHA, workflow and event. A commit-only query must not inherit an
  unrelated current branch filter.
- Include trigger event and full commit SHA in run evidence. No matching runs means unknown CI.
- An implicit PR lookup with no open PR keeps its CLI error and points to workflow reads;
  it cannot establish that CI is absent or passing.
- Preserve unfiltered defaults, output caps, per-turn roots and the existing read-only invocation.

Validate tool schemas, real Git history and the GitHub CLI invocation boundary, then repeat the
same real-model scenario without changing its prompt, permissions or scorer. Model response
quality must be assessed separately from deterministic tool expectations.

## Evidence

Both selector-schema regressions and the no-open-PR recovery regression fail before their fixes.
The integrated focused selection passes 68 tests. The production build passes. The focused host
read-tool Electron eval passes both cases; both captures were inspected. The expanded workflow
card shows IN_PROGRESS, the push event, and the entire SHA without clipping. Local macOS captures
are evidence rather than committed Linux references.

Qwen3.6 35B A3B via LM Studio, ordinary permissions and the unchanged main-history prompt passed
deterministic expectations in 36.9 seconds. It used `git_log.ref` correctly, recovered from the
PR-only error, and queried workflow runs by full commit SHA without shell or write tools. Its
merge list matched the repository history. Qualitative verdict: fail. It called queued/cancelled
runs green even though the tool explicitly reported unknown. These read-tool improvements do not
establish reliable model judgment; the tool-use scorer alone cannot certify the final answer.
Preserve this result and report repeats rather than selecting only a favorable run.

An identical repeat passed the tool-use scorer in 32.9 seconds and made the same unsupported
green-CI claim from follow-up workflow samples. A separate exact-tip push query shows the actual
four push workflows are successful, so the answer's status happened to be correct; its evidence
and reasoning did not establish that. This motivates a direct branch-status read as follow-on
work, rather than a claim that the selector changes fix model judgment.

Final local full check: 17,068 passed, eleven failed, one skipped. Eight failures reproduce on
unchanged main; two CI-planning cases are sensitive to the uncommitted checkout, and the known
filesystem-watcher timeout also appeared under full-suite load. Rerun the checkout-sensitive cases
on the commit and isolate the watcher before publication. All static gates and the build passed.
