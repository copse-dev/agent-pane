# Unowned capability gaps

Status: **Reference audit, dispersed.** Compiled 7 August 2026 against `main` at `b35c0b2`.
The findings have been folded into the plans and issues that own them — see the map below.
This document remains as the evidence and the record of the sweep; it is not a backlog, and
work should be tracked in the destinations rather than here.

Companions:

- [`user-control-surface-gaps.md`](user-control-surface-gaps.md) — capability we already have
  and do not expose. Different axis: that audit asks what a user cannot steer.
- [`competitive-landscape.md`](competitive-landscape.md) — seven named products, compiled
  2026-07-27.
- [`background-agents-capability-map.md`](background-agents-capability-map.md) — the same
  exercise against the background-agents primitives.

## Why this exists

Assistants that run models on the user's own hardware have converged on a recognisable set of
capabilities, and several are ones we had never written down either way: pooling more than one
machine on a desk, plans whose steps carry dependencies and per-step verification, named agents
with their own model and notes, awareness of what the hardware can currently do, voice, richer
notebook capture and retrieval, and a phone in the same product family.

Most of those belong to general assistants rather than coding agents, so the question is not
which of them are features but **which are ours to want, and which of those had nobody written
down**. The audit excluded anything with an existing plan or issue. What remained was ten
findings, and — as the map shows — nine of them belonged inside something we already had.

## Method and confidence

- **The findings are about our code, and they are proven.** Each cites a file and line, or the
  absence of any hit across `src/`, `packages/`, the sibling documents in `docs/plans/`, and
  the 96 open issues listed on 2026-08-07. False negatives remain possible where the code uses
  vocabulary the search did not guess — the same caveat `user-control-surface-gaps.md` carries.
- **Nothing here rests on anyone else's product.** The category description above is the prompt
  for the questions, never the evidence for an answer, and sits at screenshot-and-marketing
  confidence. No conclusion changes if a given product turns out not to work as it appears to.
- Not runtime-verified. Findings are from reading, not from running the app.

## Where each finding now lives

| ID   | Finding                                                        | Home                                                                                                                                                    |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-01 | A LAN machine cannot serve models; approval is unreachable     | **#1572** (decision); [`provider-host-allowlist.md`](provider-host-allowlist.md) §5.4, [`execution-runtime-security.md`](execution-runtime-security.md) |
| G-02 | Hardware class is declared, never measured                     | [`model-roles-and-defaults.md`](model-roles-and-defaults.md) §3; fit-before-download on #1246                                                           |
| G-03 | Plan steps carry no dependencies, effort, or todo link         | **#1570**; [`plan-mode-and-rewind.md`](plan-mode-and-rewind.md) schema section                                                                          |
| G-04 | Todo checks resolve against the workspace, not the thread root | **#1571** (defect, unverified; #1439's family)                                                                                                          |
| G-05 | Voice absent everywhere                                        | [`user-control-surface-gaps.md`](user-control-surface-gaps.md) → Missing                                                                                |
| G-06 | Memories lack captured sources and user-directed querying      | [`knowledge-store.md`](knowledge-store.md) Phase 4                                                                                                      |
| G-07 | No named agent profile                                         | **#1573** (R-05, now filed)                                                                                                                             |
| G-08 | Non-coding work is unmeasured                                  | [`industry-benchmarks.md`](industry-benchmarks.md) — recorded as a scope decision                                                                       |
| G-09 | Off-desktop reach has issues but no decision                   | [`user-control-surface-gaps.md`](user-control-surface-gaps.md) R-10 (#802 #659 #1382)                                                                   |
| G-10 | Single-user by construction                                    | [`privacy-data-flow.md`](../privacy-data-flow.md) — recorded as a non-goal                                                                              |

Four new issues and eight amended documents — seven plans plus
[`privacy-data-flow.md`](../privacy-data-flow.md), which is where the single-user non-goal
belongs. Nothing was left as an entry in this document alone.

## The evidence

Kept because the destinations above carry the design implication and this carries the proof.
Deliberately compressed; the reasoning is in the home each one went to.

### G-01 — A machine on your own network cannot serve models

`assertProviderHostAllowed` returns early for loopback and local base URLs, consults the
built-in host set, then calls `assertLowRiskProviderHost`, which throws for private and
link-local addresses and `.local` mDNS names **before the user's approved-host set is
consulted** (`packages/llm/src/provider-host-policy.ts:28`, `:81`). Approval is unreachable for
exactly the addresses a machine on your own network has.

SSH workspaces are a different capability: `ExecutionTarget` is `{ kind: 'local' } | { kind:
'ssh'; hostId; remoteRoot }`, resolved from the active project
(`src/main/services/ssh-workspace/execution-target.ts:11`) — one project, one host, chosen
ahead of the run.

### G-02 — Nothing measures the machine

The hardware budget is a declared class (`HARDWARE_CLASSES`, Compact ≈8 GB through Server
96 GB+, picker still pending). The only runtime resource instrumentation located in main is
`src/main/services/diagnostics/event-loop-watchdog.ts`; sizing advice links out to a
third-party VRAM calculator (`src/shared/context-window-advice.ts:22`).

### G-03 — Plan steps have no shape

`planStepSchema` is `{ id, label }` (`src/shared/threads/plan-schema.ts:29`). Todos separately
carry `status`, an optional `check`, and `assignedModel: 'cloud' | 'local'`
(`packages/agent/src/wire-types.ts:31`). No relation between the two, no dependency edges, no
effort tier, no expected output.

### G-04 — Verification runs against the wrong root

Per-step verification is real and executes: `verifyTodoCheck` runs the declared check through
the permission gate, and a failure reverts the item to `in_progress` rather than letting the
model mark it done (`src/main/services/todo-verification.ts:22`,
`src/shared/todos/todo-logic.ts:81`). But it resolves against `getWorkspaceRoot()`
(`todo-verification.ts:26`) rather than the thread execution root
(`src/main/services/execution-root.ts:12`), so under per-thread worktrees it would read the
shared checkout. Not reproduced — #1571 carries the repro steps.

### G-05 — Voice

At the audited snapshot there was no product path for dictation, microphone input,
speech-to-text, or read-back in `src/`, `packages/`, `docs/`, or the open issues. ACP capability
probing can report an agent's prompt-audio support, but Copse exposes no voice surface of its
own. Video attachments never decode audio ([`video-frames.md:149`](../video-frames.md)).

### G-06 — Notes

OKF knowledge notes, a Memories pane with tags and inline editing
(`src/renderer/views/memories-pane.ts`), a Doc type (#871), a Playbook type (#874), prompt-time
surfacing (#870). The pane already lets a user create, browse, edit, and delete plain Markdown
memories. What is absent is richer capture — images, transcripts, saved artifacts, or source
metadata — and a user action that asks or searches across the notes rather than handing them to
the agent through prompt-time injection.

### G-07 — Named profiles

R-05 in [`user-control-surface-gaps.md`](user-control-surface-gaps.md) recorded this with a
"new issue" action that had never been filed. #1355 imports external profiles as subagents and
#1336 covers personal packs; neither gives the user a configuration they can name and return
to.

### G-08 — Domain breadth

SWE-bench Verified subset, Terminal-Bench, doctrine evals, SkillsBench. SkillsBench alone
carries non-coding tasks (`3d-scan-calc`, `ada-bathroom-plan-repair` in
`benchmarks/skillsbench/dataset-v1.1.json`). Nothing regresses drafting, summarising, or log
review.

### G-09 — Off-desktop reach

#659, #1382 and #802 are open with no document connecting them.
[`competitive-landscape.md:52`](competitive-landscape.md) records platform reach as the only
row where we trail every competitor, and argues ACP reach is the cheaper route than porting
Electron. That argument was on paper and unowned as a product path.

### G-10 — One person

No account, no hosted backend, no product telemetry
([`privacy-data-flow.md`](../privacy-data-flow.md)); notes and threads are local files.
[`mission-control.md`](mission-control.md) parks "a second person looking at someone else's
run".

## What was deliberately not concluded

Three findings were closed as **decisions rather than work**: voice (G-05), domain breadth
(G-08), and the single-user boundary (G-10). None is a promise to build, and each is now
written down in a place where "we are not doing this" is legible. From outside, an absence and
a decision look identical, and only one of them is a position.

Two findings remain genuinely open questions rather than tasks: whether a LAN peer fits the
threat model (#1572) and whether a named profile is a settings feature or a change to what a
thread is (#1573). Both are cheap to decide and expensive to answer accidentally.

One caveat on priority, since an audit invites being read as a work queue: nothing here
outranks the surface `mission-control.md` specifies. This document found what nobody had
written down, and unwritten is not the same as important.

## Maintenance

Anything characterising the category dates fast and was never load-bearing. The citations to
our own code are the durable half — re-check them before acting, since the destinations above
assume a schema and two call sites stay where they are.
