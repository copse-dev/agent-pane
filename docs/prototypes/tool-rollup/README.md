# Tool rollup interaction prototype

This is a non-production interaction prototype for grouping tool activity that spans multiple persisted assistant messages. Open [`index.html`](index.html) directly in a browser.

The motivating trace contained one user prompt followed by eight tool-bearing assistant messages. Their persisted tool-item counts were:

```text
6, 6, 6, 2, 2, 2, 2, 2
```

Each substantive operation was paired with a separate Guardian Review, so the visible counts represented 14 operations plus 14 reviews.

## Proposed direction

The prototype compares four presentation models:

- **Current** — one rollup per persisted assistant message.
- **Whole turn** — everything after one user-origin prompt until the next user-origin prompt.
- **Runs** — the recommended option. A visible assistant response starts a run; following tool-only assistant messages join it until the next visible assistant response or prompt boundary.
- **Steps** — every reasoning/tool step remains a top-level row.

The default **Runs** view demonstrates the intended balance:

1. Keep persisted messages and stream ordering unchanged.
2. Summarize a run with a short description of what happened, with counts and failures as secondary metadata.
3. Expand a run into chronological reasoning/tool steps.
4. Use Copse's existing left-rail treatment; do not add cards around whole agent steps or intentional horizontal rules between them.
5. Keep outlined chevrons in a fixed disclosure column. While a child step is active, replace its chevron with the muted Copse activity spiral.
6. Add one rail for tertiary data. At deeper levels, reuse the capped inset rather than consuming horizontal space indefinitely.
7. Exclude Guardian Reviews from user-facing operation counts by default. The prototype's **Count reviews** toggle exists to compare the alternative; their final audit/detail placement remains a product decision.

## Run boundary

For the recommended model, derive presentation runs from the ordered message sequence:

- Start at an assistant message containing visible prose and regular tools, or at the first tool-only assistant message after a prompt.
- Absorb following assistant messages when they contain tools/reasoning but no visible assistant prose.
- Stop before the next assistant message with visible prose, the next user-origin or machine-origin prompt, or the end of the exchange.
- Keep subagent timelines top-level unless a separate product decision explicitly includes them.
- Do not rewrite or merge persisted messages. This is a derived presentation model.

A failure should remain visible in the run summary but does not need to split the run. If chronology proves confusing in a reproduction, treat an error boundary as a testable product variant rather than silently changing persistence.

## Current implementation context

At the branch base, Copse still builds tool display items from one message at a time:

- `buildMessageEl` and `finalizeMessageEl` in `src/renderer/views/conversation.ts` create and hydrate one message DOM subtree.
- `renderToolCards` receives that message's `toolCalls`, preserves expansion state, and reconciles message-local cards.
- `buildToolCallDisplayItems` and `summarizeToolTurn` in `src/shared/tools/tool-display.ts` build a rollup from the supplied array.
- `maybeSummarizeToolTurn` in `src/renderer/controller/agent.ts` already asks the small-tasks model for a concise past-tense summary, but only for the current message.
- `setMessageToolSummary` in `src/shared/store/thread-helpers.ts` persists that message-local summary and refreshes the existing tool-card path.

Reuse the existing summary service and fallback labels. The missing layer is a stable cross-message presentation run that owns combined calls, ordered reasoning sections, and live refresh routing.

## Suggested implementation shape

Introduce a pure helper that derives display runs from the thread's ordered messages. Each run should expose:

- a stable anchor message id;
- all member message ids;
- regular tool calls in chronological order;
- reasoning/tool step boundaries;
- aggregate status and failures;
- an optional generated summary;
- enough source identity to restore expansion state without changing persistence.

Render the combined rollup on the anchor message and suppress duplicate top-level tool cards for member messages. A `tool_call_started`, `tool_call_updated`, reasoning update, message completion, history hydration, or backfill affecting any member must resolve the same run anchor.

The current per-message `toolSummary` field should not be blindly reused as a run summary. Either derive a run-level summary outside persisted messages, or define a durable run summary with an explicit schema and migration/fallback behavior. Keep deterministic labels while the small-tasks request is unavailable or pending.

Guardian Reviews should eventually carry explicit presentation metadata from the ACP adaptation layer. Avoid a permanent filter based only on the display string `"Guardian Review"`.

## Acceptance criteria

Expected outcome for the production implementation:

- The recorded `6,6,6,2,2,2,2,2` topology renders as two run summaries around the two visible commentary messages, not eight tool rows.
- The second run uses a descriptive past-tense summary with secondary metadata for 11 substantive operations and one failure.
- Expanding a run reveals all reasoning/tool steps in original order.
- Every step can expand independently into its operations and results.
- Tertiary data adds one nested rail; deeper nesting does not keep shifting content right.
- Right-side chevrons stay visible and pinned at narrow widths. Left disclosure icons are optically centered.
- A running run uses Copse's normal accent activity icon. A running child step uses the muted activity icon instead of a chevron; completed children use outlined chevrons.
- No product-authored horizontal rules are inserted between steps.
- Guardian Reviews do not inflate the default operation count and remain auditable somewhere in the expanded/detail experience.
- Live streaming and restored history produce the same grouping.
- Expansion state survives updates to any member message.
- Subagent cards retain their existing top-level behavior.
- The layout works at the repository's supported narrow and normal conversation widths and honors reduced motion.

## Required validation for the implementation PR

Follow the repository's visual-change workflow; this prototype PR itself does not modify product rendering.

1. Add unit coverage for run derivation, boundaries, failures, nested steps, Guardian filtering, and stable anchors.
2. Add the smallest focused browser/WebdriverIO fixture that seeds the multi-message topology through a real product boundary.
3. Assert the combined DOM structure, counts, statuses, and disclosure behavior.
4. Save focused light/dark screenshots at normal and narrow widths using `.cursor/skills/screenshot-validate/SKILL.md`.
5. Run the test oracle, the selected focused tier, and `pnpm run check` before committing the production change.

## Open decisions

- Whether Guardian Reviews belong inside expanded run details, a separate audit disclosure, or both.
- Whether a generated run summary should be persisted or regenerated from stable inputs.
- Whether failures merely annotate a run (shown here) or end one.
- Whether machine-origin prompts should always create the same boundary as human-origin prompts.
