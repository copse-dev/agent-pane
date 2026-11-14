# Matched x64 composer capture diagnostic

This is a dispatch-only diagnostic carrier, with two immutable public sources:

1. Main `453ac5c12eb56a897aebf43292209ec9d7886b03`.
2. Accepted-reference source `5d14c144b6a1dd75834bd44ba69345256cba56fc`.

The remaining question is why the accepted bordered/content-grown captures and
later canonical captures have different transcript origins. Earlier ARM64
observation showed correct reservation and natural two-CSS-pixel scroll
movement, but its fonts differ from canonical x64 and its accepted-source
control lost its window before producing a trace. That bounded ARM experiment
is finished; this is a new matched-environment check.

## Scope and execution

Independent review of the exact carrier tree and inputs precedes native Copse
commit/publication and the one manual hosted dispatch. Keep this PR draft.
Dispatch the registered `thread-container.yml` workflow on
`codex/composer-canonical-diagnostic-20261114` exactly once after review.
There are no arbitrary-ref, case-selection or retry inputs. Rerun attempts are
rejected. The workflow is advisory and makes no canonical gate decision.

One Ubuntu 24.04 x64 job uses the normal setup action, Noto fonts, verified R2
baseline cache and ordinary Linux sandbox prerequisites. The first source uses
the freshly installed tree. The second source receives a clean locked install
from the same package-input cache; installed trees are not reused across
subjects. Electron is pinned to 44.9.3 and ChromeDriver to Chrome
152.0.7977.167. Runtime, binary hashes, font-file hashes, DPR and viewport are
recorded and compared. The fixture's original 1200x800 viewport at DPR2 is
asserted at capture; no extra resize is introduced.

Each source builds once and invokes only:

```sh
pnpm run test:e2e:ci -- --spec tests/e2e/composer-border-observer.e2e.ts
```

A failure in the first case is retained and does not suppress or replay it;
the second fixed case is still attempted once. No broad E2E suite, model run,
full guest journey or ARM retry is part of this workflow. Standard required
PR static/unit checks remain unchanged; do not add `ci-full` for this carrier.
The unrelated advisory Docker integration job is excluded only for this
diagnostic branch's PR/dispatch, retaining its ordinary and nightly coverage.

## Observation fixture

`observation.patch` extends the reviewed five-file observation fixture with a
read-only initial-target identity check. Its current SHA256 is
`7ca190b9a62acae5c710c9ba5794daa7679b1571883a5df28facbfce2dc673a2`.
The four existing source/spec/screenshot-helper patch segments are unchanged;
only the new diagnostic helper also records whether the composer, pane,
conversation, transcript and result are still the elements present at trace start.
It is applied only in disposable diagnostic checkouts. Shipping product source
and configuration types are unchanged; no product flag or API is introduced.
The original spec, assertions, phase mutations and screenshot-helper contract
are preserved. There are no forced reserve/scroll writes, masks, altered
thresholds or manual image retakes. Existing capture-stability retries, if any,
are all retained and make the exact-three-attempt collection check incomplete.

Plain JSON retains rAF/ResizeObserver/mutation geometry, actual/applied reserve,
transcript rect/clientHeight/scrollHeight/scrollTop/bottom gap, sticky bands,
assistant-result rects and reserve producer measurement/reason. The real PNG
calls have before/after samples. Producer `detail` is copied explicitly rather
than discarded by `PerformanceEntry.toJSON`. Buffered mount marks preserve
their earlier producer time; their attached geometry is sampled at collector
delivery, so it is not mount-time geometry. Instrumentation adds layout reads
and IPC timing; it is not an uninstrumented capture.

Collection completeness requires present finite rectangles, composer dimensions
and borders, applied reserve, conversation padding, transcript dimensions/scroll/
bottom gap/sticky bands, and result geometry. Each observed target must remain
the initial element. The optional result heading is explicitly null when absent.
Producer details require a finite timestamp and measurements, an explicit reason
and the previous reserve (which can be empty on initial application). Missing,
null or nonfinite required data leaves the collection incomplete. Finite movement
or reserve mismatch is retained as diagnostic evidence; completeness does not
require a fixed pose, synchronization or before/after equality.

## Evidence and failure handling

The always-run artifact retains reviewed workflow/fixture inputs, carrier and
subject commit/tree bindings, original source archives, complete actual build
archives and inventories, runtime/font/version hashes, all raw capture attempts,
phase/timeline JSON, stdout/stderr, launcher outcomes and failure logs. Hydrated
reference files are never substituted for missing generated captures. Only
generated originals matching retained raw attempts are copied. Profile paths
are sampled from the actual transient harness env file using a fixed three-key
allowlist; provider keys and arbitrary environment values are not exported.
The final record checks whether those observed profile paths remain after
normal harness teardown. Missing profile observations or remaining paths keep
the collection incomplete.

Failed builds retain their partial bundle bytes. A stale output directory blocks
attribution and is left untouched; a case that never invoked the spec cannot
claim another case's captures. Spawn failures and timeouts retain command receipts
and partial logs.

The runner bounds each command, drains only its own command session, and uses
the existing CI janitor patterns before and after each case only inside the
dedicated hosted job. Cleanup checks for remaining matching PIDs; process
snapshots omit arguments. No host developer environment is supported.
Read-only token permissions, `persist-credentials: false`, existing public
fixtures and blank model API keys require no new secrets, account or purchase.

A zero diagnostic exit means both collections completed in a matched runtime,
not that a screenshot or product gate is approved. Stop after the two actual
outcomes if attribution is still impossible. Retain unresolved holds. No
baseline/label/status changes, acceptance because a difference is inherited,
automatic fix, broad rerun or third case follows.

Local focused checks:

```sh
python3 -B -m unittest discover -s tests/fixtures/composer-capture-diagnostic -p test_runner.py
pnpm test -- composer-capture-diagnostic ci-workflow-invariants ci-dependency-cache-invariants ci-node-version
pnpm run check:local
```

CI/test-infrastructure changes require full gates. Use the explicit draft/cloud
validation route when deferring the broad suite; list actual local results and
the ordinary required PR CI run. The matched hosted pair remains unexecuted
until its frozen payload has been independently reviewed.
