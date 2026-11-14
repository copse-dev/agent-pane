# Native parent-turn steering

Tracking: #658. Prototype, native primary loop only.

Reconciled with main `60a6bf77b71a98d1772b45acc66b857de02bb582` on
13 November 2026. Recovery/yield/orchestration
PRs #4199, #4206, #4209, #4072 and #4212 are merged and retained.

## Acceptance

- A human can select Steer on a queued plain-text message while a native parent runs.
- The current tool batch finishes, then the next model request receives the note without cancellation, a new turn, or a continuation-budget reset.
- The note is held durably before admission; delivery records and provider history survive restart. Undelivered notes require explicit human follow-up.
- Stop and turn completion settle pending steering without dispatching another turn. Pending approvals remain unchanged. Child agents and review loops receive no steering mailbox.
- Runtime evidence uses a controlled tool boundary, observes the actual next provider request, and asserts the queue and transcript in Electron with a screenshot.

## Scope

This does not implement ACP steering, subagent broadcast, pause/resume, or long-task terminal-condition enforcement. Existing recovery PRs #4209, #4206 and #4199 retain their scope and branches.

## Validation

Focused loop, service, storage, controller and native-runtime coverage is required. Full `pnpm run check` is mandatory for loop control, persistence and IPC; a draft may use the documented cloud-validation route with explicit remaining gates.

The focused suite covers ordered admission, original model-call limits, Stop,
completion, stale nonces, blocked/redacted prompts, checkpoint failure, ambiguous
restart and saved transcript order. The Electron spec uses a controlled local
provider through the supported provider settings, runs both real file tools, and
inspects its actual next request and disk receipts. Its pending, applied and
stopped captures require whole-image review; this proves native plumbing, not
model quality. Raw synthetic requests, receipts and history are retained under
`.tmp/native-steering-evidence/` for the local review.

The initial screenshot review exposed a pre-saved queue note appearing before
the completed assistant step after reload. The main transcript writer now places
the applied note behind that step while preserving anchored non-message records;
the live reducer uses the same boundary, and a storage regression plus a native
restart assertion cover the order.

Pending notes are not completed transcript boundaries. If a later note remains
queued, the live reducer inserts the applied note immediately after the last
non-pending message, matching the durable writer, while preserving other message
and queue order. Regressions cover a note already at the boundary, a pre-saved
note before its completed step, a missing window note and successive applications.
The native provider scenario keeps a later ordinary note queued while the first
note is applied, asserts the live transcript and queue, and captures that state.
It holds that later note through Steer before Stop and verifies it remains
undelivered across reload without dispatching a separate request.

The added stream events and client-sent queue field change the protocol shape.
Main already carries unreleased v67 above released v65 (`v0.1.0-beta.16`), so the
release-based compatibility gate permits the shared unreleased version.

### Integrated runtime and visual evidence

Main's explicit-worker relay (#4299) returns before the primary steering session
is constructed. Delegation tests assert that explicit workers advertise no live
steering nonce, while preserving their direct result and single usage accounting.
The integrated focused suite passed 119 tests. Local static checks and build
passed; the steering, readonly-worker and recovery Electron specs passed all 14
cases. Three ACP fixture setup failures in the wider local suite reproduced on
clean main with the same Git/signing environment; no signing settings were changed.

Full cloud runs [43434090312](https://github.com/copse-dev/agent-pane/actions/runs/43434090312)
and [43434558023](https://github.com/copse-dev/agent-pane/actions/runs/43434558023)
passed on `e10aa71ddaa73f65c50f50aac0d8329ce4531376`, including the full unit
gate and all 477 native specs. The first run's nine native shards passed on their
first attempt. This is implementation evidence preceding the final reference
commit; that commit still requires its own mandatory cloud gates.

The complete canonical Linux review contained 12 committed steering/queue
references and two recovery candidates. All full before/after images were
inspected. The running-rebase capture now targets `.input-footer`, preserving its
detached branch, running-state, unavailable-recovery and tooltip assertions while
excluding optional Changes/follow-up rows that refresh independently. The recovery
continuation capture targets `.msg-machine-origin`; the spec separately waits for
the exact final assistant response and idle state. Neither capture relies on a
delay or masked product content. The owning recovery spec passed all eight cases
after these synchronization and framing changes.

The two accepted hashes come exclusively from immutable Linux artifact
`reference-screenshot-candidates-43434090312` (ID `14045353906`, ZIP SHA-256
`ce0dcd74c26c77018e7a0c1511a7c52b861254e77601c005e006ac4fdec6cff7`).
The trusted publisher pinned compare commit
`5415b13932e9997b46211f113605ff37429a2b87`, whose sole parent is that source
and whose only change is the screenshot manifest. Local macOS images were
inspected as device evidence and were not used as references. No unresolved
candidate was declined to clear the review gate.

### Ordering correction and current integration

The queued-note ordering regression failed in three layouts before the fix:
an applied note already at its boundary, a pre-saved note before its completed
step, and a note missing from the window. The reducer now uses the durable
writer's last non-pending boundary; successive applications preserve note order.
The third native case captures one applied note while a later ordinary follow-up
remains queued, then holds that follow-up through Steer and Stop and checks it
stays undelivered after reload.

Source `0049fca7878427736c86d73bedb4b925ab46b5a0` passed
[full CI 43463219049](https://github.com/copse-dev/agent-pane/actions/runs/43463219049)
on integration merge `1e69183b58c620685ee1c0eb2fcf2bd9e90f5a00` into main
`36cb38cd545673f3c03c93a76f82dfc07d886769`: 18,200 unit tests passed,
22 skipped, zero failures; all 482 native specs passed on their first attempts
across nine shards. Its local canonical exclusive-controller batch passed all
15 steering, worker and recovery cases; all 21 device images were reviewed.

The complete Linux packet reviewed all 14 committed reference pairs and seven
candidates. Only `native-steering-applied-with-queued.png` belongs to this change:
hash `ecb912f40a9926ab2a506f6a029e6fa3be8bdeb8f95c56db710d2ae84f112ed3`,
from artifact `14059404541` (ZIP SHA-256
`c6e2b1a2fc79f81c0333d289002f728f5ca62802d90b9b694004a9837c78979f`)
and manifest-only compare `5f833e0a311ea17c091b4046cedc859ca4274e47`, whose
sole parent is that source. Six unrelated candidates retain existing references:
the prior main Settings/automation row redesign, the independently reproduced
composer scroll pose, and the previously reviewed browser capture scale change.
Their complete frames, owning assertions and causal evidence were checked; no
unresolved image or macOS capture was accepted as a Linux reference.

Main's later Activity fix (#4213) caused an actual conflict between two adjacent
writer tests. The integration retains both the steering placement regression
and main's stale-interruption snapshot regression, alongside its renderer and
writer behavior. Current-main focused/static/device checks and the next signed
source's full cloud gates remain required; earlier green source results do not
waive them.

An independent ordinary-queue control on main `6be60f04` reproduced deleted
queued text returning after completion and reload. The canonical run reached
the intended absence assertion and failed, with the full image inspected.
That persistence defect is owned as a separate follow-up; its ghost image is
never a reference and its base provenance is not a correctness waiver.

## Delivery contract and restart limits

Only a live primary native run advertises the opaque nonce used by the Steer
action. The renderer durably holds the note with that nonce before admission;
main reads it back and rejects stale runs, hooks, machine messages, attachments,
skill/agent invocations, empty notes and oversized notes. Admission is ordered and
limited to 16 notes per run. The boundary applies blocking submit hooks and PII
redaction in the original run context. Neither tools nor approvals are interrupted.

`user-steering.jsonl` is metadata-only delivery evidence. `accepted` precedes
insertion; `applied` follows an awaited provider-history checkpoint and main's
removal of the held queue entry. Queue removal and the receipt share the project
write queue; later renderer autosaves cannot resurrect an applied note. Applied means
the note is saved in context, not that a model has read or followed it. A Stop
during that checkpoint can prevent the next request. Notes that miss the boundary
remain held for explicit release or editing. No steering receipt dispatches a turn.

History, queue metadata and the receipt are separate atomic writes. After a crash between them,
an accepted note is ambiguous and must not be steered again under the same ID.
Inspect the canonical saved note and provider history before deciding whether a
new prompt with a new identity is needed. Accepted identities cannot be edited,
deleted from the queue, or reused by Release; those actions are not recovery for
an accepted but uncheckpointed note. Main settles delivered notes without a
connected window. An applied
receipt implies that the held entry was already removed, and prevents duplicate
steering. The live run nonce is excluded from saves and discarded when loading
old metadata; a later ACP run cannot inherit steering eligibility.
No claim of automatic crash recovery or provider-level exactly-once delivery is made.

## Protected prompt compatibility

Steering uses the same isolated main-owned prompt review as ordinary human submissions.
Main freezes the saved unaccepted user message, queue revision and active native run;
the protected window shows the exact note, target and model. Renderer metadata cannot
establish authority. Review is deliberately a blocking host wait: the current tool
batch may finish while the window is open, but the next step waits for its decision.
The whole protected review pauses idle and absolute hard deadlines through the
run-owned host-wait registry (decision 13), then resumes the original budgets.
Cancel closes review and retains the original held note. A declined review or
Stop/completion before durable acceptance leaves the note held without canonical
acceptance. Completion closes an open review and does not preserve unapproved edits;
this bounded prototype does not automatically start a follow-up turn. Late
approval cannot revive the closed run.

Before insertion, the project write queue validates that exact saved revision and commits
canonical reviewed text with accepted lifecycle state under the existing message ID.
The reviewed body is written to a fresh immutable revision file; the atomic spine
replacement commits its reference and lifecycle together. Stop before that replacement or
a failed replacement preserves the original body/spine and a readable thread, with only
an unreferenced revision file left behind.
Derived hook audit cards are excluded from the prompt revision and remain preserved;
text, role, attachments and the saved queue payload must still match exactly.
Retirement or edits that win first prevent delivery; acceptance that wins first prevents
retirement and renderer role/body replacement. The store never substitutes a new identity.
Blocking submit hooks and redaction run as before, but their history/context effects occur
only after canonical acceptance. The provider-history checkpoint still precedes the applied
receipt and the next provider request. Once durable acceptance succeeds, finish the
local checkpoint, applied receipt and queue removal even if Stop has arrived; the
loop checks abort before its next provider request. Stop can therefore leave a saved,
applied note without a subsequent request. Checkpoint/receipt failures remain fail-closed and
crash-ambiguous notes are never automatically replayed. This does not claim provider-level
exactly-once delivery.
