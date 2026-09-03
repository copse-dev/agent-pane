# Model-proposed threads (`propose_thread`)

An agent working on one task keeps noticing others. The parser it just fixed sits
behind a settings loader that swallows malformed input; the module it read has no
tests; the migration it worked around should just be done. Every one of those has
three bad endings and one good one. It can silently widen the task and hand back a
diff nobody asked for. It can bury the suggestion in a paragraph of prose that
scrolls away. It can block the turn asking permission for work that is not
running. Or it can **offer** the work as a thread the user starts with one click.

`propose_thread` is the fourth one.

## What it is not

It is not a permission prompt, and the difference is the whole design.

A permission prompt interrupts because something is _already happening_ and
cannot proceed without an answer: the shell command is composed, the loop is
blocked, and "decide later" is not on the menu. That is why approvals are modal
(`src/renderer/views/approval-dialog.ts`), why they coalesce a burst into one
prompt, and why Approve is briefly disabled when the batch changes underneath a
click.

A proposal is the opposite shape. Nothing is running. Nothing is blocked. The
agent has already moved on. Ignoring the card forever is a perfectly good
outcome — it costs nobody anything, and the offer is still there next week. So it
renders inline in the transcript, as a card among the turn's other cards, and the
only thing it asks for is a click it will never chase.

## The offer

The agent calls `propose_thread` with four things that matter:

| Argument    | What it is                                                     |
| ----------- | -------------------------------------------------------------- |
| `title`     | A short name — the card's heading, and the new thread's title  |
| `summary`   | Plain-language description of what the run would **do**        |
| `rationale` | Why it deserves its own thread rather than this one (optional) |
| `prompt`    | The exact text the new thread starts with                      |
| `files`     | Paths it expects to touch, for display only (optional)         |

`summary` and `prompt` are separate on purpose. The summary is what the user
reads and decides on; the prompt is machine text written for an agent with none
of this conversation as context. Cards that show the prompt _as_ the description
are how these surfaces turn into unreadable JSON dumps, so the card leads with
the summary and keeps the prompt one disclosure away.

The tool **returns immediately**. The agent is told the offer was made, never
whether it was accepted — see `threadProposalAcknowledgement` in
[`thread-proposal.ts`](../packages/thread-store/src/thread-proposal.ts), where the
wording lives with its test. Two failure modes it exists to prevent: an
acknowledgement that reads as success would let the model report work nobody
agreed to, and one that reads as rejection would invite it to re-propose the same
thing on the next turn.

## The card

Three states, all of them in the transcript:

- **Standing offer.** Open by default. The title, the summary, the rationale, a
  chip saying the work gets its own checkout, a chip listing the files, the
  prompt behind a disclosure, and two buttons: _Start this thread_ and _Not now_.
- **Started.** Collapsed to one quiet line with a check and _Open thread_. The
  link lives in the header, not the body: a settled card is collapsed, and "take
  me to that work" must not be behind a disclosure. If the thread it made has
  since been deleted, the line stays honest and drops the link.
- **Dismissed.** Collapsed to one quiet line. Expanding it offers _Bring it
  back_, because "not now" is usually about timing rather than about the idea.

Only the standing offer keeps the accent rail; settled cards drop to plain border
and no fill, because they are history rather than an ask.

## Starting one

Accepting walks the same road the composer walks for a first message — checkout
committed in main, then the prompt into the transcript, then a fresh human turn
tree, then dispatch (`src/renderer/controller/thread-proposals.ts`). What it adds
is the isolation the card promised: the checkout is requested as `'worktree'`, so
the proposed work gets its own branch and directory instead of landing on top of
whatever the user has open. The repository has the last word — a project with
worktrees disabled, a non-git folder or a detached HEAD degrades to the shared
checkout through the ordinary policy in
[`worktree-policy.ts`](../src/shared/git/worktree-policy.ts).

Order matters: the thread is created first (so autosave writes it before the
checkout IPC needs it), and a failed checkout leaves nothing but an empty thread
— no user message, no dispatch, and the offer still standing on the card that
made it.

## Where the answer lives

The proposal itself is never persisted twice: it is the `propose_thread` call's
own arguments, already in the transcript, addressable by tool-call id. Only the
**answer** is stored, as `threadProposals` on the offering thread's `meta.json`
(one row per proposal, last write wins). The thread a proposal created also
records `proposedBy` pointing back at the offer.

The answer lives on the offering thread rather than being derived from whether a
started thread still exists — deleting that thread must not put the card back to
"start this?", and a dismissal has no thread to derive anything from at all.

## Related

- [`docs/ui-taste.md`](ui-taste.md) — approval prompts versus offers
- [`docs/thread-store-format.md`](thread-store-format.md) — `meta.json` fields
- [`docs/shell-permissions.md`](shell-permissions.md) — the real gates
