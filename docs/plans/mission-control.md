# Knowing what your agents are doing

Status: **Proposed.** No implementation is on `develop`. This is a specification for one
capability, written from the user's side. It covers R-04, R-06, R-20 and R-22 from
[`user-control-surface-gaps.md`](user-control-surface-gaps.md), which collapse into a
single surface and should be one issue rather than four.

## The problem

A person running several agent threads at once cannot tell which ones need them, which are
stuck, and what any of them produced. They poll the app by eye, and they reconstruct what
happened from transcripts.

## Who this is for

**There is no user research behind this document.** What there is, and it is better than
invented personas, is a 139-item roadmap written by a real user in their own words while
using the product daily on a real repository. Every job below quotes it. Quotes are
verbatim from the 27 July 2026 export, typos included.

### Primary — evidenced

**A maintainer running many agent threads in parallel on a repository they own.** They
start more work than they can watch, step away mid-run, and come back needing to
reconstruct what happened. They are technical, they trust the tool with their working tree
only because they approve what it runs, and their scarce resource is **attention**, not
tokens.

That shapes the design: the goal is not a more autonomous agent. It is getting the user's
attention to the right thread at the right moment.

### Secondary — assumed, unvalidated

- **A developer delegating one long task and leaving.** Assumes people want unattended
  runs. _Check:_ whether the evidenced user ever wants a run to proceed past a decision
  without them, given they chose a tool built on per-command approval.
- **Someone picking work back up the next morning.** Assumes a session-spanning workflow.
  _Check:_ whether threads are actually resumed across days, observable today from thread
  timestamps in the store.
- **A second person looking at someone else's run.** Assumes collaboration. _Check:_
  nothing in the roadmap asks for this. Out of scope until it does.

## Jobs to be done

### Job 1 — "Which of these needs me right now?"

Some threads are working, some have stopped and are waiting for an approval or an answer.
Nothing tells the user, so they poll by eye. Nothing in the main process even constructs a
notification.

> "I'm confused why some approval prompts end up hapening twice. Is this just the model or
> a race?" — `ca6b52c0`

> "Roadmap review when runnign, if the user hits open it continues in the background but
> the user can't view it again." — `1f265385`

**Done when** a stopped thread announces itself, and the user can answer it without first
finding it.

### Job 2 — "Is this one working, or stuck?"

A running thread and a wedged thread look identical.

> "It seems like however there's another problem in that the model is finished and there is
> still an endless loop happening." — `830efc77`

> "Quitting a heavy looping thinking stream often takes a long time for it to stop" —
> `a6bb72a1`

> "The model removed the items from todos, whilst continuing to expect and follow them. Is
> there an issue here?" — `041ef704`

**Done when** a thread that has stopped making progress is distinguishable from one that
is working, without opening it.

### Job 3 — "Where's the thread I was thinking of?"

Titles arrive late or stay blank. There is no filter.

> "We should add a filter thread option for the left menu. Clicking it shows a search for
> now, later we could add filters such as cloud, pr raised etc." — `79b0286f`

> "We dropped the 'new thread' label it should show that until the model has given it one,
> rather than blank." — `2928d837`

> "Should we add a way to jump back to roadmap from a thread? additionally what happens if
> two threads are relating to one roadmap item?" — `6f7b7d13`

**Done when** the user can find a thread by what it was about or what state it is in, and
every thread has a usable name from its first turn.

### Job 4 — "What did this actually do?"

After a run the only record is the transcript. Delivery state lives on GitHub, not in the
app.

> "Can we show the Github status for threads. If there's a pr(s) open and if they're all
> merged?" — `bfa09823`

> "The new simplified rollups make it a little unclear what is a subagent vs not." —
> `c70556c2`

> "If I close and reopen the editor, when I look into a cloud agent run; do we load the
> latest results for it?" — `41946bd2`

**Done when** a run's outputs — plan, diff, pull request, review result, screenshots — are
reachable from the run without reading the transcript.

### Job 5 — "Don't lose my work when I look away."

Separate bugs with one shape: the user's state is not durable across their own navigation.

> "Roadmaps that are partial should be auto saved. If the user clicks on a different item
> the text box is lost." — `218318a6`

> "When I start a new thread with an attachment, if I then switch back to another older
> thread. The composer has the attachment (without the text)." — `2b52cb17`

> "When starting a prompt on a dirty state we should tell the user to confirm first,
> suggesting they use a worktree first or risk data loss." — `7f284ad5`

**Done when** navigating away, quitting, and relaunching all preserve what the user had in
progress, including a pending approval.

## The view

One panel, addressable from anywhere, listing every thread in the workspace. Not a new
place work happens — a place work is _seen_. Opening a row goes to the existing thread.

```
┌─ Activity ──────────────────────────────── [filter ▾] [search] ─┐
│                                                                 │
│  NEEDS YOU (2)                                                  │
│  ● approve  write_file src/main/ipc/…      auth-refactor   4m   │
│  ● answer   "which migration order?"       schema-bump    12m   │
│                                                                 │
│  WORKING (3)                                                    │
│  ◐ running  tool 14 · last output 3s ago   deps-audit     22m   │
│  ◐ running  tool 61 · last output 9m ago   flaky-tests    51m  ⚠│
│  ◐ delegated  no window open               docs-sweep      2h   │
│                                                                 │
│  READY (1)                                                      │
│  ✓ done     PR #1312 open · checks green   control-plan    1h   │
│                                                                 │
│  ▸ Done (14)   ▸ Backlog (3)   ▸ Abandoned (6)                  │
└─────────────────────────────────────────────────────────────────┘
```

The grouping is the design. Ordering is by **claim on the user's attention**, not recency:
stopped-and-waiting first, work in progress next, finished after that, closed-out
dispositions collapsed. The marker on `flaky-tests` is Job 2 — nine minutes without output
on a thread that is nominally running.

### What a row must carry

| Element         | Why it is there                                                                          |
| --------------- | ---------------------------------------------------------------------------------------- |
| state           | Jobs 1 and 2. Needs-you states distinct from working, and both from finished             |
| what it wants   | Job 1. The specific approval or question, answerable from here                           |
| progress signal | Job 2. Time since last output, not since start — a long run is fine, a silent one is not |
| name            | Job 3. Assigned on the first agent turn, never blank                                     |
| delivery state  | Job 4. Branch, pull request, checks, review outcome where they exist                     |
| artifacts       | Job 4. Count and access — plan, diff, screenshots, review findings                       |
| disposition     | Job 3. User-set, separate from runtime state, filterable                                 |

## States

Runtime state is derived and not editable. Disposition is set by the user. Both exist at
once: a thread can be `running` and `backlog`.

| Runtime        | Means                                     | Enters when                | Attention |
| -------------- | ----------------------------------------- | -------------------------- | --------- |
| working        | Producing output                          | Turn starts                | none      |
| stalled        | Nominally running, no output past a bound | Silence exceeds the budget | soft      |
| needs approval | Blocked on a permission decision          | Permission gate holds      | hard      |
| needs answer   | Blocked on a question                     | Agent asks the user        | hard      |
| delegated      | Running with no window attached           | User delegates and leaves  | none      |
| finished       | Turn ended cleanly                        | Agent settles              | soft      |
| failed         | Ended on an error                         | Run throws or aborts       | hard      |

Disposition, user-set and persisted: `working`, `ready`, `done`, `backlog`, `abandoned`.
Existing archived threads migrate to `abandoned`. Attention level drives notification, so
it belongs in this table rather than in a separate settings surface.

## Edge cases

The ones most likely to be skipped, and what should happen.

- **Nothing has ever run.** The panel explains what it will show rather than rendering an
  empty frame. It is a first-run surface as much as a monitoring one.
- **Two hundred threads.** Groups are counted and collapsed, not rendered. Drawing a row
  must not load that thread's history, which is what #998 is fixing. This view depends on
  that fix, not the reverse.
- **Twelve threads need approval at once.** Notify once with a count. One notification per
  thread per stop, coalesced within a short window.
- **The same approval appears twice.** Already reported as `ca6b52c0`. Answering here must
  be idempotent, and a duplicate must not produce a second notification.
- **The user is looking at the thread that stops.** No notification; the stop is visible.
- **A delegated run stops for approval and nobody is there.** It stays stopped and
  notifies. It must never auto-approve, because per-command consent is the product. So
  delegation is bounded by approvals — a deliberate limitation, and it should be stated in
  the interface rather than discovered.
- **A thread is deleted while running.** Its notification is withdrawn.
- **Relaunch with a pending approval.** Still pending, still listed. This is the durability
  half of Job 5 and may already partly work.
- **Same-second state changes across many threads.** The list reorders at most a few times
  a second, or it becomes unreadable exactly when it is most needed.
- **Two threads on one roadmap item.** Both link back and the item shows both. Currently
  undefined; `6f7b7d13` asks it and it needs an answer before Job 3 ships.

## Non-functional requirements

### Performance

- Panel opens in under 150ms with 200 threads, from index data only, never from message
  history.
- A state change appears within 500ms of the event.
- Stall threshold: default five minutes of no output, configurable, per-thread override for
  known-slow work.
- The stall check must not itself poll the agent loop.

### Access

- Fully keyboard operable: open, move between groups, approve or answer, jump to thread.
- State is never carried by colour alone. Each state has a distinct glyph and label.
- Notifications respect the OS quiet-hours and reduced-motion preferences.
- A screen reader announces the group and the state, not just the thread name.

### Data and migration

- Disposition is added to the thread store. Existing threads default to `working`;
  `archivedAt` maps to `abandoned` and is then retired.
- The store is filesystem-native and greppable and must stay so. Disposition goes in each
  thread's metadata, not into a central index that becomes a second source of truth.
- Migration is one-way and must be safe to interrupt. A thread half-migrated on a crash
  reads as `working`, the harmless default.
- Sequenced behind [#1153](https://github.com/copse-dev/agent-pane/issues/1153) and
  [#1222](https://github.com/copse-dev/agent-pane/issues/1222), both changing how the store
  writes.

## Success

Measurable without adding telemetry, which the product does not collect and should not
start collecting for this.

- **Time from a thread stopping to the user answering it.** The core measure. Today bounded
  only by when someone next looks. Measurable in local testing with the window
  backgrounded.
- **Stalls found by the view rather than by hand.** Every stall in the roadmap today was
  found by noticing something felt wrong.
- **Pending approvals lost to a restart.** Target zero, by test.
- **Roadmap items this closes.** Seven are cited above. They either close or they do not.
- **Not a measure:** time spent in the panel. A user who never needs to open it is being
  served well.

## Out of scope

- **Making the agent more autonomous.** This helps a person supervise; it does not reduce
  what they approve.
- **Cross-machine or cross-user visibility.** No hosted backend, and nothing in the
  evidence asks for it.
- **Cloud-agent integration.** Roughly ten roadmap items concern remote runs. They will
  want a row here, so the row format should not assume a local process, but they are not
  specified here.
- **Fixing the stalls.** This surfaces them. The loop and abort-latency defects are
  separate work.
- **Metering and cost.** Usage attribution has its own defects and its own home (#1154).

## Open questions

- **Is the panel the sidebar, or beside it?** The projects pane already lists threads and
  shows some status. This may be that pane growing up, which would be cheaper and less
  duplicative. Needs a design call before build.
- **What is the stall threshold really?** Five minutes is a guess. It should come from
  timing real runs, and a semantic-search or benchmark run may legitimately exceed any
  fixed number.
- **Does delegation survive contact with per-command approval?** If most delegated runs
  stop on an approval within minutes, delegation is not useful and Job 1 is the whole
  product. Answerable cheaply by instrumenting a few local runs, and it should be answered
  before the delegated state is built.
- **Do the secondary users exist?** All three are assumptions. The morning-resumption one is
  checkable today from thread timestamps.

## What would make this document wrong

If the evidenced user's real complaint is that runs need supervising at all, then a
supervision panel is a better bandage rather than a fix, and the effort belongs in making
runs trustworthy instead. The quotes suggest otherwise — they ask to _see_ more, not to be
asked less — but that is an interpretation of one user's notes, and it is the assumption
most worth attacking.
