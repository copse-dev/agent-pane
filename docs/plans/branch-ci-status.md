# CI status for branches without an open PR

## Task brief

Repeated real-model runs asked `get_ci_status` about main, hit its open-PR requirement, then
misread an empty failed-workflow sample as green. Tool-use scoring passed while the answer was
wrong. Give the native status read an explicit branch scope and an implicit fallback when the
current branch has no open PR. Preserve the existing PR service and durable watches.

Acceptance:

- Resolve the remote branch tip through GitHub and inspect only push-triggered runs at that SHA.
- Select the newest run per workflow; keep the scope and evidence limit explicit.
- Pending, unfamiliar, absent or truncated evidence cannot establish success. Cancellation fails.
- Explicit PR selection and authentication failures cannot silently become branch queries.
- Branch and PR selectors are mutually exclusive. An explicit branch bypasses PR discovery.
- No checkout, fetch, source write, broader permission, or durable-watch behavior change.
- Put overall status, branch and exact SHA first so they are visible in the initial tool-output
  scroll area. Prove status visibility with a real text-range/layout assertion.
- Explain an empty file-history result; when its file filter also resolves to a Git revision,
  suggest the explicit `ref` argument without silently guessing the user's intent.
- Reproduce the native-tool failure, validate statuses and CLI boundaries, then repeat the same
  real-model question and judge the final answer separately from its tool-use score.

## Evidence

The native no-open-PR regression, ambiguous file-history regression, and initial-scroll status
visibility assertion each fail before their fixes. Final branch/PR/prompt/watch/history tests pass
(120). The final full local check completed: 17,081 passed, ten known failures, one skipped. Eight
failures reproduce on unchanged main and two CI-planning cases are sensitive to the uncommitted
checkout; rerun the latter after committing. All static gates and the production build pass.

With the same Qwen3.6 35B A3B, LM Studio, prompt and ordinary permissions, direct branch CI reads
returned the actual four successful push workflows at main's exact remote tip. The 21-second run
used two native read tools and gave an evidence-backed merge list and CI answer. A 20.1-second
repeat also reported CI correctly but used a less precise closed-PR history query; its full
workflow verdict is partial. Both passed the unchanged tool-use scorer.

A separate real-model run with simulated queued GitHub read evidence passed tool-use scoring in
20.3 seconds and correctly called CI queued rather than green. Its history answer was wrong after
putting main in the file filter; that motivated the general history recovery hint above. This is
simulated GitHub evidence, not a claim that any live workflow was queued or modified. These small
samples do not establish broad model reliability.

After the history hint, the same queued-evidence scenario passed in 22.4 seconds: it repeated
`path: main`, consumed the hint, retried `ref: main`, read the correct history, and reported queued
CI rather than green. The final live-GitHub run also passed in 22.4 seconds, recovering from a
`.git` file filter and reporting the actual four successful push workflows. Both final disposable
workspaces remained clean at the expected main SHA; no shell or write tools were used.

The final focused Electron eval passes all three cases (4.1 seconds). All three captures were
inspected. The text-range geometry assertion fails before the output-order fix and passes after it:
overall status, branch and SHA are visible without scrolling in the 200px result area. Local
macOS captures are evidence rather than committed Linux reference replacements.
