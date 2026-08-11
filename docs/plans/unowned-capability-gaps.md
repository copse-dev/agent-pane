# Unowned capability gaps

Status: **Reference audit.** Findings only. Nothing here is scheduled, and nothing should be
built from this document without a follow-up issue that states the decision it rests on.
Compiled 7 August 2026 against `develop` at `0616abd`.

Companions:

- [`user-control-surface-gaps.md`](user-control-surface-gaps.md) — capability we already have
  and do not expose. Different axis: that audit asks what a user cannot steer.
- [`competitive-landscape.md`](competitive-landscape.md) — seven named products, compiled
  2026-07-27.
- [`background-agents-capability-map.md`](background-agents-capability-map.md) — the same
  exercise against the background-agents primitives.

## Why this exists

Assistants that run models on the user's own hardware have converged on a recognisable set of
capabilities, and several of them are ones we have never written down either way: pooling more
than one machine on a desk, plans whose steps carry dependencies and per-step verification,
named agents with their own model and notes, awareness of what the hardware can currently do,
voice, a notebook the user writes into, and a phone in the same product family.

Most of those belong to general assistants rather than coding agents, so the question is not
"which of them are features" but **which of them are ours to want, and which of those has
nobody written down**. Only the second half is this document's subject.

The audit therefore excludes anything that already has a plan or an issue, however early. What
remains is small, and most of it is a decision rather than a backlog item.

## Method and confidence

- **The findings are about our code, and they are proven.** Every absence below cites a file
  and line on `develop`, or the absence of any hit across `src/`, `packages/`, the 50 sibling
  documents in `docs/plans/`, and the 96 open issues listed on 2026-08-07. False negatives
  remain possible where the code uses vocabulary the search did not guess — the same caveat
  `user-control-surface-gaps.md` carries.
- **Nothing here rests on anyone else's product.** The category description above was assembled
  from shipped local-first assistants and from
  [`competitive-landscape.md`](competitive-landscape.md), at screenshot-and-marketing level of
  confidence. It is the prompt for the questions, never the evidence for an answer, and no
  recommendation changes if a named product turns out not to do what it appears to.
- Not runtime-verified. Findings are from reading, not from running the app.

## Findings

### G-01 — A second machine on your own network cannot serve models, by policy

`assertProviderHostAllowed` returns early for loopback and local base URLs, consults the
built-in host set, and then calls `assertLowRiskProviderHost`, which **throws for private and
link-local addresses and for `.local` mDNS names — before the user's approved-host set is
consulted** (`packages/llm/src/provider-host-policy.ts:28`, `:81`). Adding the LM Studio server
on your other Mac under Settings → Approved provider hosts therefore cannot work: approval is
unreachable for exactly the addresses a machine on your own network has.

SSH workspaces are not the same capability. `ExecutionTarget` is `{ kind: 'local' } | { kind:
'ssh'; hostId; remoteRoot }` and is resolved from the **active project**
(`src/main/services/ssh-workspace/execution-target.ts:11`) — one project, one host, chosen
ahead of the run. That is remote execution of a whole checkout, not a second inference
endpoint and not a per-step placement decision.

**Owner: nobody.** #712 (unify isolation on a container boundary) and #1246 (local model
lifecycle) are adjacent and neither is about trusting a peer on your LAN.

What it needs first is a decision record, not code: how a peer is paired and identified, what
leaves the machine when a prompt is served remotely, and whether a trusted LAN peer is a hole
in [`threat-model.md`](../threat-model.md) or a documented exception to it. The cheapest honest
slice is an explicit per-host pairing that is a **separate** concept from the approved-provider
list, so the blanket private-address rejection stays the default for custom providers.

### G-02 — Nothing knows what the machine can do right now

The hardware budget is a user-declared class — `HARDWARE_CLASSES`, Compact (≈8 GB) through
Server (96 GB+), with "UI to pick the class is pending"
([`model-roles-and-defaults.md:173`](model-roles-and-defaults.md)). Nothing measures the real
machine: the only runtime instrumentation in main is
`src/main/services/diagnostics/event-loop-watchdog.ts`, and the sizing advice we do give links
out to a third-party VRAM calculator (`src/shared/context-window-advice.ts:22`).

Absent, in order of what it costs us: no "this will not fit" before a download rather than
after; no back-off when a long local run meets memory or thermal pressure; no input to the
role recommendations that reflects the machine as configured rather than as declared.

**Owner: partial.** The recommendation half sits in `model-roles-and-defaults.md`; the
measurement half has no plan and no issue.

Worth pricing honestly before anyone starts: reading system telemetry is new privileged local
surface, and it needs a line in [`privacy-data-flow.md`](../privacy-data-flow.md) even though
the data never leaves the device.

### G-03 — Plan steps have no shape

The plan artifact's step is `{ id, label }` and nothing else
(`src/shared/threads/plan-schema.ts:29`). The todo layer, separately, carries `status`, an
optional executable `check` (`shell` / `fileExists` / `typecheck`) and a binary
`assignedModel: 'cloud' | 'local'` (`packages/agent/src/wire-types.ts:31`).

Three consequences:

1. **Two step models that do not reference each other.** The plan a user approves and the
   todos the loop executes are separate structures; nothing binds a todo to the plan step it
   discharges, so per-step progress on an approved plan cannot be shown without inventing the
   link at render time.
2. **No dependency edges.** A flat ordered list cannot express that steps 3 and 4 are
   independent, which is the precondition for running them concurrently — newly possible now
   that per-thread worktrees (#869) give two runs separate checkouts.
3. **No effort or cost dimension.** `assignedModel` is a two-value hint, not a tier, so the
   model classifier (#557) has nothing per-step to size against and no place to record what it
   picked.

**Owner: #1080 owns the artifact**, currently P1 and fixtures-only. Nothing owns step
dependencies or per-step effort. This is the one finding with an obviously right next move:
extend the schema in #1080 **now**, while no writer depends on it. Doing it after writers exist
costs a migration.

### G-04 — Self-checking exists and is better than it looks, but is wired to the wrong root

Worth recording because an outside audit would score it as missing. Per-step verification is
real and executes: `verifyTodoCheck` runs the declared `shell` / `fileExists` / `typecheck`
check through the permission gate, and a failed check reverts the item to `in_progress` with
"Acceptance check failed" rather than letting the model mark it done
(`src/main/services/todo-verification.ts:22`, `src/shared/todos/todo-logic.ts:81`).

One adjacent defect, noticed while reading and **not runtime-verified**: that verification
resolves paths against `getWorkspaceRoot()` (`todo-verification.ts:26`) rather than the thread
execution root (`src/main/services/execution-root.ts:12`). Under per-thread worktrees a
`fileExists` or `shell` check would then run against the shared checkout instead of the
thread's own — the same family as #1439, which is already open against the ACP native-tool
bridge. If it reproduces it belongs on #1439's family, not on this document.

### G-05 — Voice: no hit anywhere

No occurrence of voice, dictation, microphone, or speech-to-text in `src/`, `packages/`,
`docs/`, or the 96 open issues. Attachments cover image, video, and text; video explicitly
never decodes audio ([`video-frames.md:149`](../video-frames.md)).

The interesting part is not the absence but the tension. Our bet is per-command approval, and
approval is the one interaction that should **not** be hands-free — "yes" spoken across a room
is a poor consent signal for `rm -rf`. A voice surface for us would be dictation into the
composer and read-back of a result, with the approval queue deliberately excluded. That is a
smaller feature than it first appears, and a different one.

**Owner: nobody.** Listed so the absence reads as unexamined rather than as declined.

### G-06 — Notes are the agent's memory, not the user's notebook

We have more here than a feature list would suggest: OKF knowledge notes, a Memories pane with
tags and inline editing (`src/renderer/views/memories-pane.ts`), a Doc note type (#871), a
Playbook type (#874), and prompt-time surfacing (#870).

Absent: note kinds the **user** captures rather than the agent — an image, a transcript, a
saved artifact; notebooks scoped to anything other than a project; and asking a question of
your own notes as a user action. #870 is prompt-time injection into the agent's context, which
is a different feature that happens to share a store.

**Owner: partial.** The store, the types, and the injection path are owned; user-authored
capture and user-facing retrieval are not.

### G-07 — A named agent with an identity

The organising unit in a general assistant is an agent — a name, a model, its own
instructions, its own notes, its own unread state, kept across sessions. Ours is a thread
inside a project, and the difference is not cosmetic.

R-05 in [`user-control-surface-gaps.md`](user-control-surface-gaps.md) already records named
reusable configurations as missing with a "new issue" action, and that issue is **still
unfiled**. #1355 imports external custom-agent profiles as subagents and #1336 covers personal
packs; neither gives the user a persistent named agent to return to.

This is a product-shape question, not a backlog item. Organising around agents rather than
repositories changes what a thread is, what a project is, and what the notes store is scoped
to. The concrete action is the smaller half: file R-05.

### G-08 — Nothing measures the non-coding work done in the same window

Our benchmark surface is SWE-bench Verified subset, Terminal-Bench, doctrine evals, and
SkillsBench — and SkillsBench does carry non-coding tasks (`3d-scan-calc`,
`ada-bathroom-plan-repair` in `benchmarks/skillsbench/dataset-v1.1.json`). All of it measures
the agent's plumbing on engineering-shaped work.

Assistants aimed at general work regress the other half — log review, drafting, summarising
— because that is their product. People run that work through our composer too, and its
quality is unmeasured. A coding agent choosing not to regress memo-writing is a legitimate
scope decision, not a defect; the defect would be leaving it undecided.

**Owner: nobody for domain breadth.** #752 and #1311 own benchmark design and study validity,
not what domains are in scope.

### G-09 — Off-desktop reach has two open issues and no plan between them

#659 (web/mobile session hand-off) and #1382 (Linux and Windows GA readiness) are both open,
with no plan document connecting them.
[`competitive-landscape.md:52`](competitive-landscape.md) already records platform reach as the
only row where we trail every competitor including the analytics tool, and its closing argument
is that protocol reach through ACP — which we implement on both sides — may be the cheaper
route to the same end. That argument is on paper and nothing implements it as a product path.

Products built on a native Apple stack get iOS and macOS from one codebase; we would be
porting Electron. That asymmetry is exactly why the ACP route deserves the decision rather
than the port.

### G-10 — More than one person

Everything is single-user by construction: no account, no hosted backend, no product telemetry
([`privacy-data-flow.md`](../privacy-data-flow.md)), notes and threads as local files.
[`mission-control.md`](mission-control.md) explicitly parks "a second person looking at someone
else's run".

Sharing a note, a plan, or a run has no plan, no issue, and no decision record. Given the
privacy position this is almost certainly a **non-goal**, and the right output is one paragraph
saying so — from outside, "unowned" and "declined" look identical, and only one of them is a
position.

## Already owned, so not a gap

Recorded so this audit is not misread as a longer list than it is. Each of these is common in
the category and already has an owner here.

| Capability                        | Our owner                                                              |
| --------------------------------- | ---------------------------------------------------------------------- |
| Cross-run overview, activity feed | [`mission-control.md`](mission-control.md) (Proposed)                  |
| Delegate and walk away            | #1081, [`background-supervisor.md`](background-supervisor.md)          |
| Scheduled routines                | [`automations.md`](automations.md) — prototype ships, app must be open |
| Automatic model choice            | #557, [`model-classifier.md`](model-classifier.md)                     |
| Local model download lifecycle    | #1246                                                                  |
| Tabbed chats, split workspace     | #1245                                                                  |
| Interactive artifacts             | MCP-UI canvas, #611, #867                                              |
| Pause and cancel a run            | Interrupt and abort exist; graceful pause is R-02 (#658)               |
| Working-directory file browser    | Shipped (`src/renderer/views/file-tree.ts`)                            |

## What to do with this

In order, cheapest and most reversible first:

1. **Extend the plan-step schema under #1080** (G-03) — dependency edges, an effort tier, a
   link to the todo that discharges the step, and an expected-output field. Fixtures-only today
   makes this a schema edit; after writers land it is a migration.
2. **Write two decision records** — G-01 (a trusted LAN peer) and G-10 (the single-user
   boundary). Both are "what are we" questions that get answered accidentally by whoever
   implements first if they are not answered deliberately.
3. **File the R-05 issue** (G-07) that `user-control-surface-gaps.md` already called for.
4. **Confirm or dismiss the G-04 worktree-root defect** against #1439.
5. **Decline in writing** what we are not doing: voice (G-05), domain-breadth evals (G-08), and
   platform ports over protocol reach (G-09). A one-line stance in the relevant document is the
   whole deliverable.

G-02 sits behind the G-01 decision on purpose — device measurement and device peering are the
same new privileged local surface, and deciding them separately produces two half-answers to
one privacy question.

## Maintenance

Anything characterising the category dates fast and was never the load-bearing part. The
citations to our own code are the durable half; re-check them before acting, since three of the
five recommendations depend on a schema or a call site staying where it is.
