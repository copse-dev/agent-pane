# Cross-project conversation and CI workflow audit

## Task brief

Test whether recent cross-project review and CI-follow-up workflows can be completed through
Copse's native tools. Reproduce gaps before changing behavior. Base:
`d57af855e16db5534ae1781317b9ea1e8cc16269`.

Acceptance examples:

- The latest matching conversation belongs to the last configured project: return it before
  older matches from earlier projects. Exclude the caller before taking a result page.
- Bound default discovery to 50 matches, allow up to 200, and keep older matches reachable through
  an offset. Permit narrowing to a configured project before applying pagination.
- Cancelled or unfamiliar CI checks cannot establish success. Preserve a pending signal even
  when some checks already passed.
- Implicit failure-log lookup for a known PR commit cannot substitute another commit's run.
- Preserve the existing cross-thread read/send consent and durable CI watch restart behavior.

Risk: read-tool result ordering and GitHub status classification. No new permission, persisted
format, DOM, layout, automatic retry or continuation budget. Validate the actual tool and service
boundaries with focused tests, the standard static/full check, build and existing runtime coverage.
Detailed chat evidence remains local; no private conversations are needed by the regression fixtures.

## Findings

`list_threads` already supports consented cross-project discovery and returns readable transcript
paths. It concatenated per-project catalogs, so global recency was wrong, and returned every match.
Sort the combined matches by update time with stable project/thread tie breakers, then page them.
The result stays an array with the existing spine paths. Pagination is over live data; concurrent
updates can move entries between requests, so this is not a frozen snapshot.

CI tools already support durable waits and restart recovery. However, cancelled and unknown check
buckets fell through to success. Keep unknown checks pending until they resolve or the existing
watch expires, and classify cancellation as a failed completion. Preserve pending-before-failure
precedence and existing skipped-check handling. This is conservative status classification, not a
full branch-protection model: historical cancelled duplicates and advisory checks may still need
inspection.

Implicit workflow selection also substituted the newest listed run when no run matched the PR
commit. Return no match instead; the failure-log caller already reports that no run was found.
Explicitly requested run IDs remain usable.

An additional exit-code hypothesis was rejected after live CLI reads and inspection of
[GitHub CLI's JSON export path](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go).
JSON export precedes its non-JSON failure/pending exit handling. No speculative parser change is
included.

## Existing work and remaining gaps

- Paired-browser parity belongs to [#4095](https://github.com/copse-dev/agent-pane/pull/4095).
  Closing a desktop window is different from quitting or sleeping its host.
- Bounded native workers and persistent child orchestration belong to
  [#4096](https://github.com/copse-dev/agent-pane/pull/4096) and
  [#4072](https://github.com/copse-dev/agent-pane/pull/4072). An active PR does not establish that
  its validation is finished.
- Background consent/retry work belongs to
  [#4158](https://github.com/copse-dev/agent-pane/pull/4158) and
  [#4159](https://github.com/copse-dev/agent-pane/pull/4159).
- Copse's catalog searches its own store. Reviewing history that exists only in another app needs
  an explicit read-only import/connector with bounded retrieval and separate consent.
- Host storage administration and external account management still need their appropriate
  scopes and user authorization. Missing credentials cannot be repaired by weakening containment.

## Validation

Two conversation-discovery regressions fail with the original product code. Three CI regression
cases fail on the original service. Focused tool/service and durable-watch tests pass with the fixes
(29 tests). All static gates and the production build pass. The existing Electron thread-reference
spec passes on the rebuilt source; its screenshot was inspected and the sent reference remains
inline and readable.

The full local check completed: 17,060 passed, 11 failed, one skipped. Eight failures reproduce on
unchanged main with the same dependencies: one Bash 3.2 CI-protocol fixture, six screenshot-review
fixtures rejecting macOS's `/var` alias, and one per-user-temp permission audit assertion. Two
CI-planning cases pass on clean main but fail in the uncommitted checkout; verify them again on the
committed patch. One filesystem-watcher timeout passes in isolated runs on both main and the patch.
This is not a green full-suite result. Keep publication draft until required final-head CI passes;
record its immutable links and the committed-checkout rerun in the PR.

No live model inference, physical-phone validation, daemon deployment or successful full-night run
is established by these deterministic tests.

## Screenshot review follow-up

Reviewing the five PRs exposed a hidden dependency on unrelated checkout updates in the phone-control
fixture. A clean disposable workspace reproduced [#4190](https://github.com/copse-dev/agent-pane/issues/4190):
phone and cross-thread submissions released a WeakMap-owned lock without notifying the composer.
Submission ownership now lives in session-only store state; the composer selects its active lock.
Both controller-path component regressions fail before this fix and pass afterward, without a later
token, Git event or state write. The stable-workspace mobile spec passes both scenarios, and the
four worker scenarios also pass on macOS. All ten local captures were inspected; Linux CI remains
the baseline source. Final phone and running-worker captures explicitly frame the transcript after
shell resizing and wait for scrolling to settle. Required final-head cloud checks and screenshot
review remain prerequisites for merging.

## Post-merge live evaluation

The five workflow PRs (#4183, #4185, #4187, #4188, #4189) were merged before this
follow-up. Evaluation started from main `20e805b016d8efa8646790c938c568ef6f40e289`;
fixes were subsequently rebased onto `92c89179fdf386d262957f600de1aceb187d2cf2`.
The original checkout and daily app profile were preserved. Tests used isolated
visible Electron sessions, the already-loaded local Qwen3.6 35B A3B model, and
ordinary permissions. No model was loaded/unloaded or security policy relaxed.

Acceptance recorded before editing: native dated history and exact-commit CI;
read-only CI diagnosis; globally recent chat discovery and readable progress;
separately consented synthetic handoff; real mobile/worker/reference integration;
and explicit distinction between Copse history and history stored only in Codex.
The expired-SSH-prompt acceptance criterion was added when a live run reproduced
that failure, before its implementation changed.

### Product gaps reproduced and fixed

- Native `git_log` lacked timestamps, causing a local shell `git log` solely to
  answer “since last night.” Return ISO committer timestamps with each bounded
  history row. Named history also explicitly identifies its local provenance:
  a local main SHA can lag the current remote CI SHA. Tool guidance describes
  comparing SHAs and reading remote commits through the existing GitHub API tool.
- Discovery returned project IDs but no names, and reading a selected chat
  required navigating spine references. Add project names and a native
  `read_thread` tool: 10 messages by default, at most 20, chronological within
  each page, backward offset and explicit next-page offset. Cap each message at
  4,000 characters and summarize tool names/statuses without loading tool blobs.
  Preserve integrity checks, path guards, existing thread-scoped read consent,
  own/parent exceptions, cancellation/revocation, and separate send consent.
  Both native and ACP agents receive the tool. It reads Copse's store only.
- Main expired an SSH askpass request after 60 seconds but left its modal open.
  A screenshot showed the expired modal covering the next ordinary approval.
  Main now dismisses the exact request on its original renderer when settled;
  renderer removes expired queued requests and advances without answering or
  remembering a secret. Late dismissal cannot close a newer prompt. The new
  event is protocol-additive (two additions, zero breaks; version remains 66).
- The documented `pnpm run analyze:thread -- ...` invocation forwarded the
  separator as a filename. Strip that leading separator while preserving
  analyzer failure exit codes; the CLI regression exercises both forms and a
  negative scorer result.

### Live results and limits

Raw traces and screenshots remain local under the isolated evaluation worktree;
private source chats were used only to recover workflow intent. Cross-project
fixtures contain anonymized checkpoint text, not copied private conversations.

| Workflow                                                    | Evidence                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Original “validate what landed since last night”            | `git-ci-first-class-tools-1793990785791.jsonl`                                                       | Baseline tool scorer passed, but needed local shell dates and had an inconsistent merge count.                                                                                                                                                                                                                                                               |
| Same broad wording after dated history                      | `git-ci-first-class-tools-1793993405590.jsonl`                                                       | Failed the unchanged CI-tool assertion: used native history but omitted CI. Do not count as a successful validation.                                                                                                                                                                                                                                         |
| Original explicit merged-history + CI wording               | `git-ci-first-class-tools-1793993527105.jsonl`                                                       | Tool scorer passed in 25.6 seconds; no shell. Qualitative limit: history was an older local SHA than the remote CI SHA, and “mostly green” overstated pending evidence. This prompted the provenance fix.                                                                                                                                                    |
| Explicit history + CI after provenance fix                  | `git-ci-first-class-tools-1793994144019.jsonl`                                                       | Tool scorer passed in 91 seconds. Native fetch failed SSH authentication, but later GitHub log approvals and completion proceeded. It reported CI not green and real rate-limit failures. The final answer still omitted the local/remote SHA mismatch and overclaimed that the failures were not code defects; qualitative result remains partial.          |
| Global discovery + selected progress read, same two prompts | `cross-project-workflow-main-1793991220982.jsonl`, `cross-project-workflow-main-1793992253933.jsonl` | Before: four explore calls and spine/body navigation. Final facts were correct; the old direct-read assertion failed because reads occurred inside children. After: one `list_threads`, one `read_thread`, correct project names and three remaining items, no sends/shell/writes, 27.4 seconds. One paired observation is not a reliability estimate.       |
| CI diagnosis, original prompt, ordinary mode                | `ci-diagnose-first-class-tools-1793993615836.jsonl`                                                  | Native run/log calls and safety scorer passed in 51.8 seconds. Logs establish installation API-rate-limit 403s. The answer added unsupported quota-cause/retry/token advice and an incorrect epoch conversion; diagnosis quality is only partial. Only the scenario's explicit Guarded-YOLO opt-in was removed; assertions were preserved.                   |
| Synthetic handoff                                           | `cross-project-handoff-main-1793993928245.jsonl`                                                     | A user-started fixture receives a separately consented send; recipient completes an acknowledgement naming all three items, keeps agents frozen, and makes no tool calls. The earlier assistant-only fixture submitted successfully but failed the local model template; retain that failed attempt rather than treating a submission receipt as completion. |

The original vague validation wording and unsupported causal claims remain model
judgment limitations; passing tool-use assertions does not establish factual
correctness. No claim is made that all original Codex workflows now work reliably.
The existing external-history import/connector and paired-browser window-close
work remain separate scope; the mobile-control test does not prove #4095 is on
main or establish physical-phone/window-close behavior.

### Regression and device evidence

The new date/provenance, analyzer-separator and expired-dialog tests fail against
their prior implementations. Focused store/tool tests cover pagination, lazy
reads, truncation, missing/tampered/symlink content, invalid bounds, denied read,
separate sending, cancellation and project removal during consent. Registration
and ACP tests cover the model-visible schema and readonly classification.

Four real Electron specs pass (nine cases): `workflow-read-evidence`,
`mobile-controls`, `native-isolated-workers`, and `thread-reference-picker`.
The focused Chromium `ssh-prompt-expiry` spec passes: assert the modal opens,
dismiss it by request ID, then type into and focus the real composer. Main
lifecycle tests advance the actual 60-second deadline with fake timers. This
proves the two boundaries and additive IPC contract; it is not a live SSH-server
credential test. No credentials were entered or changed.

Inspected captures include dated history, conversation title/project/checklist,
composer usable after expiry, live before/after conversation answers, and the
blocked SSH prompt. Local macOS captures are evidence only; Linux CI owns
committed screenshot references. No baseline was accepted from a Mac capture.

Final full-check and cloud-gate results are recorded in the follow-up PR. Keep
publication draft until required gates and screenshot review complete. Earlier
static runs exposed new lint/type errors in tests; those were fixed, not treated
as host noise.

### Final provenance review and Codex ACP control

Final review added the existing external-content envelope to both conversation
catalog and transcript results. Text from another conversation is historical
data, including any quoted instructions. A real registry regression returns
catalog/transcript text containing a forged closing tag and proves that it
cannot terminate the envelope; sending permission remains ungranted. The test
fails before the provenance declarations. The focused tool/registry suite then
passes all 53 cases; the complete focused selection passes all 192 cases. The
framed-payload Electron card spec passes both cases, and its capture was
inspected. This framing does not change permission decisions.

The completed local full check on `733b3b848f53cbea48ecb9e8328c282019156ea4`
passed all static gates: 17,217 unit tests passed, nine failed, one skipped.
All nine failures reproduce on unchanged main: one Bash 3.2 protocol fixture,
six `/var` screenshot-review guards, one per-user-temp read assertion, and the
shell replay. The replay initially differed between worktree locations; checking
out unchanged main in the exact fix directory, keeping dependencies and build
artifacts constant, reproduces all 37 differing rows with an identical digest.
Do not label the full suite zero-failure. The later provenance follow-up is
validated by focused checks and the final-head full cloud run under the
previously documented draft/cloud-validation route.

To separate local-model judgment from app capability, two additional controls
used the existing authenticated `acp:codex` route with explicit normal `agent`
permissions. Matching backend turn-context metadata establishes `gpt-6.1-sol`,
medium effort. These controls ran on the committed build before the provenance
follow-up, without changing credentials, model defaults or assertions:

- `git-ci-first-class-tools-1793996156940.jsonl`: the original explicit question
  obtains current remote history through `gh_api_read` and exact-SHA CI through
  `get_ci_status`. It correctly reports all six observed push workflows green
  at `92c89179`, explicitly excluding PR-only/protection requirements. The
  unchanged tool scorer fails because its history group permits only `git_log`,
  `gh_pr_list`, or `gh_pr_view`, not the valid commits API route. Preserve this
  failed score; do not relabel it an assertion pass.
- `cross-project-workflow-main-1793996311184.jsonl`: the same two fixture prompts
  pass the unchanged scorer and final-fact assertions in 42.4 seconds. Calls
  are two native MCP `list_threads` reads and one `read_thread`; no sends,
  shell or file writes. The inspected capture shows the correct project,
  three-item checklist and instruction to keep agents frozen.

These are diagnostic controls with a different model, not paired evidence that
Qwen's quality failures were fixed. The native/ACP product route is established;
model reliability and the history scorer's narrow successful-tool group remain
explicit limits.
