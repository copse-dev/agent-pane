# Thread layout stability

Status: **Active** — the renderer-side disclosure policy, stable reconciliation, reading-anchor
preservation, and focused visual validation are implemented on this branch. Frame-level scroll
coalescing and comparison against an always-compact variant remain product follow-ups.

## Goal

Keep a thread readable while tools and reasoning update rapidly. Short gaps between
operations should not cause the same content to disappear and reappear. Status and
new content should remain timely, and an explicit user disclosure choice should win.

## Baseline findings

Before this change, the renderer had these code-backed causes of jitter:

- `applyToolCardOpenState` in `src/renderer/views/conversation.ts` derives rollup and
  group openness directly from aggregate tool status. A sequence of running → done →
  another running tool can close and reopen the same container.
- Disclosure preferences are inferred from the previous DOM. Running groups are
  excluded from the remembered open set, while individual open tools are included
  regardless of status. This both loses deliberate choices and confuses automatic
  expansion with user expansion. A user-closed running card is reopened on refresh.
- Changed regular cards and whole rollups are replaced when their serialized display
  signature changes. Existing reconciliation preserves unchanged cards and live
  subagent timelines, but not changed regular tool subtrees.
- `buildToolCallDisplayItems` in `src/shared/tools/tool-display.ts` changes structure
  at the second regular tool. Reasoning can force that wrapper at the first tool,
  and `syncNestedRollupReasoning` moves an already visible trail into it.
- `refreshToolCards` restores numeric `scrollTop` while the reader is scrolled up.
  That does not preserve the position of the text being read when content above it
  changes height. Pinned views also scroll after individual update events.
- `message_done` is a segment boundary, not necessarily the end of the run:
  `src/renderer/controller/agent.ts` emits it during text/tool handoffs too.

## Implemented behavior

Separate execution status from presentation state. Start with the existing live
detail experience, but make automatic expansion deliberate and collapse infrequent.

| Event                                  | Proposed presentation                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Tool starts                            | Show its summary/status immediately; defer automatic detail expansion.              |
| Operation finishes before reveal delay | Keep details compact; show the real completion state immediately.                   |
| Operation remains active               | Reveal eligible details once, if the reader is following the live end.              |
| Tool finishes and another starts       | Update content/status in place; keep already revealed ancestors open.               |
| Run finishes                           | Compact automatically opened regions once, after a short quiet period.              |
| User opens or closes a disclosure      | Apply immediately and retain that exact choice across updates.                      |
| Reader scrolls up                      | Stop following and defer automatic geometry changes in the visible transcript.      |
| Failure or approval request            | Surface the failure or required action immediately, independently of detail timers. |

Initial experimental values: **300 ms before automatic reveal**, **at least 1 second
visible once revealed**, and **750 ms of quiet after run completion before compaction**.
These are starting values to evaluate, not established UX thresholds. Delays affect
automatic disclosure only; they must never delay tool execution, streamed text,
status changes, errors, or approval controls.

For the first slice, hold automatically revealed regions through the run. Do not
close them just because no tool is running, or because `message_done` fired. Cancel
pending compaction when a new run starts. On error/cancellation, settle activity
indicators promptly and retain visible diagnostic details; do not hide the error
with successful-work compaction.

The main tradeoff is transcript height during long runs. Evaluate a second variant:
**routine tools remain compact throughout, updating one stable summary; details open
only on request**. This minimizes automatic movement but gives less live detail.
Use the same recorded event sequence to compare both before committing to broader
UI changes or introducing a setting. Avoid adding a growing list of per-tool delays.

## Implementation sequence and follow-ups

1. **Capture the failure and baseline.** Add a deterministic sequence covering quick
   reads, short gaps, a long shell operation, reasoning → tools → text, a failure,
   and a streaming subagent. Run it both pinned and scrolled up. Record disclosure
   transitions, visible anchor movement, and scroll writes over time; still
   screenshots alone cannot demonstrate temporal jitter.

2. **Own disclosure state explicitly.** Keep renderer-side policy state
   in `conversation.ts`. Track `auto`, `user-open`, and `user-closed` separately
   from tool status, keyed by thread/message/disclosure identity. Track reveal and
   settle deadlines with renderer timers. Use existing run lifecycle signals;
   confirm native and ACP completion semantics before wiring compaction. Clear stale
   timers on disposal, thread changes, and run restarts. Preserve user choices for
   the mounted session, including thread switches; persistence to disk is out of scope.
   Historical content loads compact without replaying reveal timers.

3. **Stabilize the live container.** Create a stable activity wrapper from the first
   tool/reasoning item so the second tool does not replace the outer structure.
   Keep its summary and reasoning node stable as tools arrive. Reconcile regular
   tools and groups by key, patching changed headers/results and retaining unchanged
   child DOM, focus, selection, and disclosure state. Restore disclosure preference
   when grouping changes, including movement to an error bucket. Do not automatically
   expand every nested level merely because an ancestor is running.

4. **Apply the timing policy.** Implement delayed reveal and run-end compaction on
   the stable wrapper. Explicit user choices override all automatic decisions,
   including an ancestor the user closed. Use a single coordinated settle pass,
   rather than separate collapse timers firing across a completed run. Include
   reasoning and subagent disclosures in the policy audit so they do not retain
   conflicting open/close rules. Keep this renderer-only; no agent loop changes.

5. **Preserve the reader's position.** For a reader away from the bottom, retain
   a surviving visible message/tool node and its viewport offset, not just the old
   `scrollTop`. Define a nearest-surviving-anchor fallback when a node disappears.
   Coordinate with browser scroll anchoring so it is not compensated twice. Keep
   the existing immediate wheel-up unpin behavior and programmatic-scroll echo
   bookkeeping. Do not force scroll after a user disclosure click. Re-evaluate
   deferred compaction when the reader returns to the live end. Frame-level
   coalescing remains a follow-up if traces still show redundant scroll writes.

6. **Compare and tune.** Review the same sequence under the current behavior, the
   held-open prototype, and the compact alternative. Decide whether long-run height
   justifies compact defaults or a bounded live preview as a separate follow-up.
   Document the chosen rule in `docs/ui-taste.md` before shipping.

## Validation and acceptance criteria

- Component tests cover reveal cancellation, minimum dwell, quiet settlement,
  cross-tool gaps, disclosure-shell identity, thread switches, lazy bodies, and
  explicit user overrides.
- Extend `conversation-tool-card-reconcile.test.ts`, `tool-display.test.ts`, and
  `reasoning-display.test.ts` for live user-open/user-closed choices, regular-card
  DOM identity, single-tool → group transitions, and reasoning placement. Replace
  the existing assertion requiring a changed regular card to be rebuilt with an
  assertion that its content updates while its disclosure shell survives.
- A focused WebdriverIO Electron visual eval follows
  `.cursor/skills/screenshot-validate/SKILL.md`. Reuse the mock/seed infrastructure,
  capture representative frames and a timestamped transition/geometry trace, and
  inspect the screenshots. Extend `scroll-to-bottom.e2e.ts` where appropriate.
- A burst of fast operations causes **zero automatic detail expansions** when each
  finishes inside the reveal window. An automatically revealed container never
  closes and reopens between operations within the same run.
- User-open and user-closed state survives every progress/status update, including
  updates after grouping and thread switches. Keyboard disclosure actions count too.
- A surviving reading anchor stays within **2 CSS pixels** of its prior viewport
  position during automatic changes above it. If content becomes too short to
  preserve that offset, assert the defined clamped fallback instead.
- Pinned readers remain at the live end after layout settles. Wheel-up interrupts
  following immediately. No stale timer affects a different thread or later run.
- Errors, action requests, status, and streamed content remain immediately available.
  Check narrow panes and increased UI scale, where wrapping amplifies height changes.
- Run `pnpm run check`, `pnpm run build`, and the required e2e validation for the
  implementation; prefer remote Electron runs when configured.

## Scope boundaries

Do not start by adding height animations: they still move the reader's content and
can obscure the underlying state changes. Preserve the existing markdown and
subagent incremental-rendering improvements. Virtualization, persisted disclosure
preferences, agent scheduling, and changes to hook/continuation behavior are outside
this plan. If implementation later needs those runtime changes, first follow the
binding hooks/feature-packs plan.
