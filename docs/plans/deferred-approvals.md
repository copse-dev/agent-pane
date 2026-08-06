# Deferred approvals and the review queue

**Status: Active (D0–D1 landed).** Prompt-cause instrumentation and the `defer`
outcome with its durable queue are implemented; D2 onward is design only. Split out of
[`unattended-runs.md`](unattended-runs.md), which originally carried this as one of
its phases. It is separate work with a separate value case: **it needs no container, no
Docker, and no new runtime**, and it is worth shipping on today's host sandbox on its own.

## What this is

A third outcome for the permission gate. Today every gate resolves to `allow`, `deny`, or
**a modal that blocks the run until a human answers**. This plan adds `defer`: the action
is refused for now, recorded as a request with everything a human needs to judge it, and
the agent is told to carry on with other work. The user reviews the queue when they get
back.

The run stops being hostage to the user's attention. That is the whole idea.

## Why it is worth doing alone

A blocking prompt costs nothing when the user is watching the run — it is the correct
design, and this plan does not change it. It costs the entire run when they are not:

- an agent clearing a lint backlog stalls at the first `git fetch` escalation and does
  nothing for the next six hours;
- a scheduled automation (`automations.md`) fires with no one at the keyboard, hits an
  approval, and pauses the thread indefinitely;
- a supervised background task (`background-supervisor.md`) wakes, needs one escalation,
  and blocks a queue slot until someone notices.

Every one of those is a run that already exists in the product and already fails this way.
None of them needs a container to be fixed.

`docs/threat-model.md` principle 3 is the standing argument: a control that makes everyday
work painful gets switched off, and a disabled control protects nothing. A blocking prompt
during unattended work is exactly that control — the user's escape hatch today is to turn
the gate off (Guarded YOLO) for the whole run, which trades a good control for a bad one.
Deferral is the middle that does not currently exist.

## Binding decisions

1. **`defer` is a gate outcome, not a new gate.** It joins `allow` and `deny` in the
   existing decision vocabulary. It is reachable only from a decision that would otherwise
   have prompted — it can never soften a `deny` or widen an `allow`, exactly the constraint
   the auto-approval classifier already lives under
   ([`auto-approval-classifier.md`](auto-approval-classifier.md)).
2. **One vocabulary.** `defer` maps onto the canonical permission vocabulary in
   `packages/agent/src/headless-contract.ts` rather than becoming a fourth dialect beside
   hook `allow|deny|ask`, ACP `allow|reject|cancelled`, and the gate's own verdicts. The
   contract's `'ask'` — "defer to an interactive approver" — is the natural mapping target
   and needs a non-interactive resolution defined for it.
3. **Deferral never silently succeeds.** The agent receives a typed tool error naming the
   reason and stating the action was queued. It must be impossible for a model to read a
   deferral as "done". A deferred action has not run and will not run until a human says
   so.
4. **The queue is durable and thread-owned.** It survives the turn, the run, and an app
   restart, because the review usually happens later. It records what was requested, when,
   the exact subject, the reasons, and the transcript position — enough to judge the
   request without replaying the conversation.
5. **Review resolves to a real action, not a note.** Approving replays the exact request
   against the same execution context. If that context is gone (runtime torn down, branch
   moved, run finished), approval must fail loudly rather than replay into a different
   world.
6. **Deferral is a mode, not a default.** Interactive runs keep prompting; nothing about
   today's behaviour changes for a user who is sitting there. Deferral is switched on for a
   run that is expected to be unattended.
7. **Every deferral is recorded in the durable decision log.** `decisions.jsonl`
   (`src/shared/threads/decision-log.ts`) already carries permission verdicts. A deferral
   is a verdict, and so is its later approval or rejection — including the fact that the
   two happened at different times and possibly by different means.

## Phases

### D0 — prompt-cause instrumentation ✅

Before adding an outcome, record why prompts happen at all. Every prompt site tags its
decision with a stable **cause**, and the causes carry a classification of what would have
removed each one.

This is the measurement `unattended-runs.md` phase U0 also depends on, and it lives here
because the prompt sites are this plan's subject matter. It is independently useful: it
answers "what is actually interrupting people?" with data instead of anecdote.

What landed:

- `src/shared/threads/prompt-cause.ts` — the cause taxonomy, an `isPromptCause` predicate,
  the per-cause containment judgement, display labels, and `summarizePromptCauses()`. Pure
  and Node-free, so the report script, the renderer, and unit tests share one source.
- `decision-log.ts` gains an optional `cause` on every event, threaded through
  `makeDecisionEvent` and `parseDecisionLine`. No schema bump: the field is optional and an
  unrecognised slug is dropped at parse time, so a log written by a newer build stays
  readable rather than failing to load.
- `ApprovalRequest.cause` carries it from the gate to `recordApprovalDecision`, so nothing
  had to grow a parallel recording path.
- Every interactive gate path sets one: the shell paths in `permission-gate.ts` (including
  the distinction between "contained but policy asked" and "nothing contains this at all",
  which is the whole point of the U0 measurement), terminal, MCP, custom tools, GitHub
  writes, web and browser origins, hooks, PII, provider hosts, review spend, ACP
  permissions and package setup.
- `npm run report:prompt-causes` (`scripts/report-prompt-causes.mts`) reads the redacted
  `decisions.jsonl` files and prints the breakdown, with `--json` for tooling. It reports
  prompts recorded _without_ a cause separately, so an uninstrumented path shows up as a
  known gap instead of silently skewing the totals.

Exit gate (met for the instrumentation; the data collection is the remaining half): every
interactive gate path records a cause; the report breaks a project's decision log down by
cause, by what would have removed it, and by how often each was approved (a cause that is
always approved is a candidate for auto-approval; one that is often denied is doing real
work).

### D1 — the `defer` outcome and durable queue ✅

What landed:

- `src/shared/threads/deferred-approval.ts` — the queue record, its type predicate, the
  request-identity key, the folding rules, and `deferredApprovalMessage()`. Pure, so the
  store, the renderer, and the tests share one definition of both the record and the
  wording.
- `deferral-mode.ts` — which threads are running unattended. Session-only and per-thread,
  mirroring `guarded-yolo.ts`: nothing in settings, so no migration or restart can switch a
  run to non-blocking behind the user's back.
- `deferred-approval-store.ts` — append-only JSONL beside the decision log, at
  `~/.copse/workspace/<projectId>/deferred-approvals.jsonl`. Append-only because the queue
  is evidence as much as state: "asked at 03:00, approved at 09:00" is what a reviewer
  wants, and rewriting the pending line in place would erase it. Resolving twice returns
  null rather than minting a second verdict.
- **One interception point.** `requestApproval` is the single seam every gate already
  funnels through, so the mode is applied there — shell, MCP, web, browser, PII, ACP and
  the rest are covered without any of them growing a second code path, and without a gate
  being able to forget.
- **It throws, it does not resolve.** Every existing caller reads `approved === false` as
  "the user declined" and carries on quietly, which would drop the request on the floor
  after telling nobody. `DeferredApprovalError` makes a deferral impossible to swallow by
  accident (Decision 3).
- A `deferred` verdict on the decision log, counted apart from approvals, denials and
  timeouts in the D0 report — folding it in would make the interruption count _rise_ the
  better deferral worked.
- Repeat asks collapse onto one entry via `deferredRequestKey`, which handles D3's
  repeat-request problem at the source rather than by steering the model.

One deliberate trade: if the queue write fails, the deferral is abandoned and the modal is
shown instead. Blocking an unattended run is bad; telling the agent something was queued
when it was not is worse, because the request would then exist nowhere at all.

Exit gate (met): a run in defer mode completes without opening a modal; every deferral is
in the queue and in the decision log; nothing a deferral touched was executed.

### D2 — review surface

- A list of outstanding requests with their context, live while the run continues and
  summarised when it ends.
- Per-item: approve and replay, approve for the rest of the run, reject with a note the
  agent sees on its next turn.
- Bulk resolution for the common case of the same shape recurring.

Exit gate: an e2e spec covering queue states, replay-after-approval against a live run, and
approval of a request whose context is gone failing loudly per Decision 5.

### D3 — loop behaviour

The open risk: an agent told "queued, carry on" may simply request the same thing again,
burning the run on a loop. This phase measures and fixes that.

- Instrument repeat-request rate per deferred subject.
- Suppress a repeat of an already-queued request at the gate — the second ask returns the
  same deferral without a new queue entry.
- If the agent still stalls, use the existing nudge/steering machinery
  (the recovery-nudge work recorded in [`industry-benchmarks.md`](industry-benchmarks.md))
  rather than inventing a second steering path.

Exit gate: a measured repeat-request rate, and a run where every escalation defers still
making forward progress on the rest of its checklist.

### D4 — consumers

Wire the mode into the runs that need it: `automations.md` schedules,
`background-supervisor.md` tasks, long-horizon checklists
([`long-horizon-tasks.md`](long-horizon-tasks.md)), and unattended runs
([`unattended-runs.md`](unattended-runs.md)). Each is a consumer choosing the mode;
none of them owns a second queue.

Exit gate: a scheduled automation that hits an escalation completes its other work and
presents a review queue, instead of pausing the thread.

## Test plan

| Area                | Tier       | What it must prove                                                             |
| ------------------- | ---------- | ------------------------------------------------------------------------------ |
| Cause taxonomy      | unit       | Every prompt site maps to a cause; the type predicate has its own test         |
| Outcome mapping     | unit       | `defer` maps onto the headless contract; cannot soften `deny` or widen `allow` |
| Queue durability    | unit       | Survives restart; ordering; no duplicate entry for a repeated request          |
| Non-execution       | unit       | A deferred action provably did not run                                         |
| Replay              | unit + e2e | Approval replays the exact request; stale context fails loudly                 |
| Agent comprehension | bench      | Deferral wording does not read as success or trigger a retry loop              |
| Review surface      | e2e        | Queue states, approve/reject/bulk, end-of-run summary                          |

## Risks and open questions

- **Wording is load-bearing.** "Queued for review, continue with other work" has to land as
  a redirect, not a failure. This is a prompt-engineering problem with a measurable answer
  (D3), not a copy detail.
- **A deferral queue nobody reads is worse than a prompt.** If the review surface is easy to
  ignore, work silently never happens. The end-of-run summary is the mitigation and should
  be hard to miss.
- **Replay fidelity.** Approving an hour later must reproduce the original request exactly
  or fail — a partially-applicable replay is the dangerous middle.
- **Open — what happens when the queue is the whole run?** If every action defers, the run
  is useless and should say so early rather than grinding. A threshold that ends the run
  with "this needs you" is probably right; the number is unknown.
- **Open — who can approve?** Today the only approver is the local user at the local UI. A
  notification path (the run finished, three things need you) is out of scope here but is
  the obvious follow-up.

## Non-goals

- Changing interactive behaviour. A user who is present keeps getting prompts.
- Auto-approving anything. This plan removes blocking, not judgement.
- A second permission vocabulary, queue, scheduler, or steering path.
- Deciding which runs are unattended — that belongs to the consumers in D4.

## Relationship to existing plans

- [`unattended-runs.md`](unattended-runs.md) is the largest consumer: an unattended
  run needs this to be non-blocking, and this needs nothing from it. Ship this first.
- [`auto-approval-classifier.md`](auto-approval-classifier.md) reduces the number of
  prompts; this changes what an unavoidable one costs. They compose and must not overlap.
- [`background-supervisor.md`](background-supervisor.md) owns durable task identity and
  wakes, including its permission-snapshot decision for delayed execution. A deferred
  approval is the interactive counterpart of that snapshot.
- [`automations.md`](automations.md) explicitly documents "commands that require approval
  still pause the scheduled thread and prompt" as a prototype boundary. D4 removes it.
- [`../threat-model.md`](../threat-model.md) principle 3 is the argument for doing this at
  all; principle 4 (observability) is why the queue and the decision log are the same
  record seen twice.
