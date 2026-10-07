# New-thread activity screen: porting the #3450 prototype

Status: **In progress, 2026-10-04.** Slices 0-6 are built; slice 7 is not started. Slices 1b, 3, 4 and 6
are open PRs (the Activity stack ending at
[#3489](https://github.com/copse-dev/agent-pane/pull/3489) and the sidebar stack ending at
[#3488](https://github.com/copse-dev/agent-pane/pull/3488)). Built behaviour that departs from the
slice text below is recorded in [Divergences from the plan](#divergences-from-the-plan).
Decisions were resolved and the plan validated by exploration on 2026-10-02. See [Validation findings](#validation-findings). This plan turns
[#3450](https://github.com/copse-dev/agent-pane/pull/3450) (`prototypes/new-thread-activity.html`,
a standalone 8,244-line mock-up) into product code.

It extends [`mission-control.md`](mission-control.md). It **reverses one decision recorded there**:
slice 1 placed the Activity panel as an overlay beside the sidebar, not as a screen. See
[Decision to reverse](#decision-to-reverse).

## Divergences from the plan

Decided during the build; the slice text below is the original plan and is superseded here.

- **Empty state (slice 3).** With nothing to list, the Activity home is hidden and the composer is
  centred vertically as well as horizontally; it docks when the first row arrives. This replaces
  the top-anchored zero-row state.
- **Strips (slice 3).** One project strip carries the need-you counts; there is no separate
  attention strip.
- **Approve and state words (slice 3).** The home uses the prototype's pill Approve and drops the
  state word for active rows; `ui-taste.md` was amended to allow both.
- **Sort (slice 4).** Sorting runs at render time over the sidebar rows and leaves the store's
  newest-first order alone, so the comparators do not replace store-level ordering. Sort and
  group-by persist per profile.
- **Answer in place (slice 6).** Questions are released through one function shared with the ask
  dialog (queued and on-screen requests alike), and quick answers render Markdown as the dialog does.
- **Automation fold (slice 4c).** The sidebar and Activity list each have their own pure fold
  (`foldAutomationRuns`, `foldScheduleRuns`); unifying them is deferred.

## Prior art (inspiration only, not a dependency)

These PRs cover parts of the prototype. They may be discarded; read them for ideas, do not
rebase onto them.

| PR                                                         | Covers                                                                    | State                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------- |
| [#3386](https://github.com/copse-dev/agent-pane/pull/3386) | Activity thread browser as the default sidebar; inspect-only `git:status` | Open                       |
| [#3148](https://github.com/copse-dev/agent-pane/pull/3148) | Activity overlay, approve/reject in place                                 | Merged (already in `main`) |
| [#3407](https://github.com/copse-dev/agent-pane/pull/3407) | Context ring with combined hover                                          | Merged                     |
| [#3371](https://github.com/copse-dev/agent-pane/pull/3371) | Thread PR icon colours and glyphs                                         | Merged                     |
| [#3449](https://github.com/copse-dev/agent-pane/pull/3449) | Roadmap document editing                                                  | Open                       |

Worth lifting from [#3386](https://github.com/copse-dev/agent-pane/pull/3386): the inspect-only
`git:status` argument and its review findings (a naive version re-read every thread's status on
any working-tree event, 40 reads for one event). Any sidebar that shows status for inactive
threads must avoid that.

**Done for the row glyph:** the sidebar's "changes" icon uses the inspect-only
`git:thread-change-summary` channel (no watcher, one read per shared checkout, TTL cache, active
thread follows working-tree events). Rows past the first 60 per pass are not asked about until a
later redraw, and SSH projects are skipped.

## What the app already has

Verified in code, so these are re-skins or small edits, not new builds:

- **Bottom panel position.** `RightPanelPosition = 'auto' | 'side' | 'bottom'`
  (`src/shared/types/state.ts:21`), `views/portrait-right-panel-layout.ts`, the
  `is-right-panel-horizontal` class on `#body`, and the `rightPanelPosition` setting.
- **All seven panel modes.** Explorer, Terminal, Changes, Browser, PRs, Memories, Roadmap
  (plus VNC). `views/right-panel-layout.ts`, `views/panel-mode-controls.ts`.
- **Maximize and pop-out** for the right panel.
- **Context wheel and footer** (`views/context-wheel.ts`, `views/input-bar.ts`, `footer-*.ts`).
- **The activity model.** `controller/activity-model.ts` is pure and metadata-only.
- **Light and dark tokens** (`styles/tokens.css`, `styles/themes.css`), with a token mapping in
  [Tokens](#tokens).

## What is genuinely new

1. **An inline Activity view** (not an overlay) as the default new-thread screen.
2. **Attention strip**: a horizontal strip of cards above the list.
3. **Sidebar sort and group-by.** Today the sort is fixed newest-first
   (`projects-pane.ts:1647`). The prototype has several sorts, reverse, and group by
   project / status / none.
4. **Answering questions in place.** Today a question row only offers "Answer in thread".

Decided out of scope: **thread drag between projects** (unsupported for now; project and group
drag stay as they are) and an **attention colour** (no new token, see [Tokens](#tokens)).

Everything else in the prototype (mock data, mock panes, prototype menu, `mp*` model-picker
mock, URL and `click=` test hooks, `localStorage` keys) is **not ported**.

## Decision to reverse (approved)

Approved by the owner: Activity may be a screen as well as an overlay.

[#3148](https://github.com/copse-dev/agent-pane/pull/3148) chose an overlay because the sidebar
is a navigation tree and the right panel would compete with Explorer/Terminal/Changes. The
prototype instead shows Activity in the centre pane when there is no thread open.

Resolve before PR 2:

- The overlay stays (shortcut `Cmd/Ctrl+Shift+A`, sidebar bell, command palette), now
  wrapping the same shared view. One renderer, two hosts.
- The centre-pane host is shown only when the active thread is empty.
- Update `mission-control.md` ("Is the panel the sidebar, or beside it?") in the same PR.

## Where it lands in the code

The new-thread screen is not a component today. `#conversation` stays mounted and empty and
`#input-bar` floats to the middle of `#pane-chat` via `.composer-centered`
(`views/chat-layout.ts`, `styles/global/layout.css:826-857`). The Activity view needs a host
that coexists with the centred composer.

`activity-panel.ts` renderers (`rowElement`, `groupElement`, `renderDetail`, `detailActions`)
are closures inside `mountActivityPanel`, bound to `selectedKey`, `timings`, `sources` and
`settling`. They must be extracted before they can render anywhere else.

## Tokens

| Prototype                                               | App                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--bg`, `--panel`, `--surface`, `--hover`, `--selected` | `--bg-base`, `--bg-elevated`, `--bg-subtle`, `--bg-hover`, `--bg-selected`                             |
| `--line`, `--line-subtle`                               | `--border`, `--border-subtle`                                                                          |
| `--text`, `--secondary`, `--muted`                      | `--text-primary`, `--text-secondary`, `--text-muted`                                                   |
| `--accent`, `--accent-fill`, `--on-accent`              | same names / `--text-on-accent`                                                                        |
| `--teal`                                                | `--success`                                                                                            |
| `--pr-merged`, `--pr-closed`                            | `--important`, `--error` (already bound by [#3371](https://github.com/copse-dev/agent-pane/pull/3371)) |

**Dropped:** the prototype's `data-attn` switch and its redefined `--warning`. Attention is
fixed and uses the existing tokens; no new colour token is added. Do not re-point `--warning`:
it is `#cca700` / `#9a6700` and drives search highlight and the diff modified colour.

## Slices

Each slice is one PR off `main`, rebased before opening. Each UI slice needs a focused
visual spec with a screenshot (`AGENTS.md`).

### 0. Plan and decision (0.5 day)

This document, plus the `mission-control.md` update. No code.

### 1. Extract a reusable activity view (2-3 days)

- Split `mountActivityPanel` into `createActivityView({store, sources, api, deps}) ->
{root, render, dispose}`; the overlay wraps it.
- Behaviour must be identical. `activity-panel.test.ts` and `tests/e2e/activity-panel.e2e.ts`
  pass unchanged (that is the proof).
- Risk: low. It touches the approval path, so keep exactly one caller of
  `approval.respond` (`answerOnce`) and the 500 ms settle behaviour.

### 1b. Keyed Activity rows (1.5-2 days) - [#3458](https://github.com/copse-dev/agent-pane/pull/3458)

Correctness first; performance only where measured.

**Measured (happy-dom, relative cost, M-series Mac; layout and paint not captured):**

| Profile (projects x threads) | Sidebar `render()` median | Nodes rebuilt |
| ---------------------------- | ------------------------- | ------------- |
| 5 x 5                        | 1.1 ms                    | 146           |
| 10 x 20                      | about 2 ms                | 283           |
| 40 x 100                     | 5.5-6.2 ms                | 823           |

The sidebar renders only the expanded project and pages threads to 10 rows, so the rebuild is
small even at 4,000 threads. A real turn fires about 5-10 sidebar-relevant events (streaming
tokens do not emit `threads_changed`); a 50-event burst costs 240-380 ms at the top size. The
activity model walk (`collectActivityThreads` + `deriveActivity`) is about 1.5 ms at 4,000
threads. The one real cost is the Activity panel's full-row rebuild, 85 ms for 400 rows (8,030
nodes), on an unrealistic profile (10% of threads running); it is already throttled to 250 ms.
**Conclusion: do not diff or patch the sidebar for speed.**

What this slice does:

1. **Keyed rows in the Activity view only.** Rows and groups are cached by key and reused while
   everything they draw is unchanged; a `patchChildren` helper reconciles the list, moving nodes
   only where the position differs. Needed because the view now lives on a screen where the user
   types and hovers, and [#3386](https://github.com/copse-dev/agent-pane/pull/3386) hit stale
   clicks and a replaced rename input from rebuilds. The detail pane is **not** patched: its
   buttons carry imperative state (the settle window and "answered" flags), so it still rebuilds
   on every redraw and a click landing on a rebuilt Approve button remains possible. Follow-up.
2. **Break up `projects-pane.ts` as it is touched** (row, group header, drag, automations
   section) when slice 4 reaches them. No up-front rewrite.

**Moved to slice 4: the shared thread-row model and the automation fold.** They were planned
here, but `scripts/check-dead-code.mts` rejects product modules used only by tests, and neither
has a consumer until the sidebar and the new screen are built around them. Building them first
would fail that gate or force a throwaway consumer.

Dropped after measurement: sidebar keyed patching, a shared frame-batching helper, and the
sidebar row cap (it is already 10).

- Inspect-only Git status for inactive threads (no watcher arming, one read per shared
  checkout) is only needed if slice 4 shows status for non-expanded projects; if so, it changes
  the `git:status` IPC and needs an API protocol version bump (see Validation findings).
- Proof: the existing `activity-panel` tests and `activity-panel.e2e.ts` pass unchanged; new
  unit tests for `patchChildren` and for row/group identity and focus; a mutation check.
- Risk: low-medium. Renderer only.

### 2. (Folded into slice 3) Activity restyle

Decided: slice 2 is part of slice 3, not its own PR. Comparing the prototype's Activity list
and detail with the current panel (2026-10-03) showed the current CSS already implements the
same list-and-detail design with real tokens. What differs and where it goes:

- **Safe restyle, small, and tied to the new layout:** a larger serif detail title and a neutral
  "Needs you" chip (the current chip is warning-tinted). Done in slice 3 with the screen host,
  so the screenshots are reviewed once.
- **Approve label:** "Approve" (decided; see Decisions).
- **Not adopted, because they contradict `ui-taste.md`:** dropping the state word from rows
  ("State is glyph + word") and pill-shaped Reject/Approve buttons (kit buttons with
  `--border-strong` outlined chips). Reopen only with an owner decision.
- **Collapsible group headers (decided: yes, in slice 3).** The prototype's headers are
  buttons with a chevron (the prototype opens with Working collapsed and the others open).
  Design points to settle in the slice, none of them in the prototype:
  - **Count when collapsed.** The prototype shows no count, so a collapsed Working group
    hides how many runs it holds. Proposed: keep the count visible, at least when collapsed.
  - **Needs you never stays hidden.** A new approval or question arriving while Needs you is
    collapsed expands it (the sidebar's Automations disclosure already auto-expands on
    attention); the user can still collapse it again afterwards.
  - **Selection and keyboard.** Arrow keys skip the rows of a collapsed group, and if the
    selected row's group collapses, selection moves to the nearest visible row (today a row that
    leaves hands selection to the next). The header is a `button` with `aria-expanded`.
  - **Persistence.** Proposed: session-only state held by the view, reset on `hide()` like
    selection, defaulting to the prototype's (Working collapsed). **Confirm** whether it should
    persist across restarts.
  - Keyed rows (slice 1b) keep expanded groups from rebuilding, so this builds on that.
- The rounded card with no header or Esc hint is the screen host's layout (slice 3).

### 3. New-thread screen host, Activity restyle and collapsible groups (5-7 days)

**Decided layout: A, composer docked, Activity list fills the pane above it** (spike below).

- Mount the extracted view in `#pane-chat` when `isActiveThreadEmpty()` is true and the thread
  has Activity to show. Note `isActiveThreadEmpty` is also false when `activeThreadId` is null.
- Drop the `.pane-chat.composer-centered` absolute-position and translate rules whenever the
  Activity view is present (`layout.css` ~826-857, and the `:not(.composer-centered)` rules in
  `input-bar.css:119,535,542`). `#input-bar` returns to docked placement; the conversation
  keeps `padding-bottom: calc(var(--chat-composer-height) + var(--spacing-md))`. The Activity
  container is `flex: 1 1 0; min-height: 0; overflow: auto`. Keep the card's hairline, shadow
  and `--radius-lg` ("one hairline, not two" in `ui-taste.md`).
- The 0-row state is the first-run case: a top-anchored empty state with the composer capped in
  width and centred horizontally. Add a short bottom fade or padding so the last row is not
  clipped above the composer.
- Add the attention strip and project strip.
- Tests that reference `.composer-centered` or the new-thread screen (verified):
  `styles/modern-css.test.ts` (4 hits), `tests/e2e/titlebar-workspace.e2e.ts`,
  `tests/demo/chat-layout-styling.demo.ts`, `portrait-panel-controls.e2e.ts`,
  `image-expand.e2e.ts`, `views/new-thread-keeps-panel.test.ts`,
  `pr-panel-new-thread.e2e.ts`, `terminal-new-thread.e2e.ts`. **Not affected:**
  `chat-layout.test.ts` (embedded-demo focus only) and `new-project-flow.e2e.ts`.
  Also review `docs/spikes/composer-layouts.html` (links the real stylesheets).
- Start by listing every spec that assumes the centred composer before any code change; on
  [#3386](https://github.com/copse-dev/agent-pane/pull/3386) the old-pane assumption cost three
  failed demo runs and 36 specs.
- **Approve label: use the prototype's "Approve" (decided; the prototype wording is intentional).**
  The Activity detail's primary button reads **Approve**, not **Approve once**. Behaviour is
  unchanged: it still sends the narrowest answer through `answerOnce` (no remembered grant, no
  task lease), only beside the full request. Touch points: the button label and its aria-label
  (`Approve once: ...`) in `activity-view.ts`; the comment in the same file; the doc lines in
  `ui-taste.md` ("Approve once is the only in-place grant") and `mission-control.md`. The
  confirmation line ("Approved once for ...", asserted by `activity-panel.test.ts` and
  `activity-panel.e2e.ts`) is not part of the prototype and keeps saying "once" so the scope of
  the grant is still stated after the click; **confirm** whether you want it shortened too.
- Docs: rewrite the `ui-taste.md` "Centered new-thread composer" and "Activity panel" sections.
- Risk: medium. The welcome screen (`views/welcome.ts`, no project open) is separate and must
  not regress. Expect a screenshot-baseline review.

### 4. Row model, sort, group-by and automation fold (4-5.5 days)

- **One derived row model** (moved from slice 1b): a pure module producing thread rows (stable
  key per thread, state, project, age, PR, attention, automation schedule) from the store. The
  sidebar and the Activity view consume it; neither walks the store itself.
- Pure comparators and a `groupBy` of project / status / none, over that row model, in a
  new controller module with unit tests; then wire `projects-pane.ts`
  (`render()` at about `:1051-1850`).
- **The sort is not applied at `projects-pane.ts:1647`.** That line is only the thread-filter
  branch. The normal path reads `getSidebarThreads` (`controller/projects.ts:171`), which does
  not sort; the newest-first order is applied upstream (`controller/persistence.ts:326`,
  `automations.ts:199`, `external-cursor-agent-sync.ts:35`) with key
  `lastHumanPromptAt ?? createdAt` (`thread-sort.ts:41-49`). The new comparators must replace
  that store-level ordering, not just one call site.
- Persist per profile in the validated settings store (two keys or one object key; not
  `localStorage`). A new setting touches: `src/shared/types/state.ts` (type, guard, field),
  `src/shared/store/store.ts:40` (default), `src/main/services/storage/settings-writable.ts:190`
  (`RENDERER_WRITABLE_SETTING_SCHEMAS`; unregistered keys are rejected),
  `controller/startup-settings.ts`, `main.ts:284,336` (guard with default fallback, which gives
  the migration-free read of old profiles) and `settings-schema.test.ts`. The API protocol gate
  should not fire (generic settings get/set), but run `gen-api-protocol` to confirm.
- **Automation runs: fold them (prototype commit `ed5aa68ec`, 2026-10-02).** The prototype
  answers the earlier open point. In both the sidebar and the Activity list:
  - Only runs that **need you** or are **working** stay as their own rows.
  - **Finished runs fold into one row per schedule** (clock glyph, run count), expandable, and
    placed at the start of the finished section so "Show more" never hides them.
  - **More than three pending approvals from one schedule collapse into one row**
    ("N need you, open in Activity"); three or fewer stay individual.
  - **Failed runs: decided, break out, but collate when many.** The prototype toggle
    (`?fail=break|badge`) resolves to break-out: each failed run is its own row so a failure is
    never hidden inside a fold. When one schedule has many failed runs they collapse into one
    "N failed" row. **Threshold (owner): two or more failed runs from one schedule collate into
    one row; a single failed run stays its own row** (read from "2 can collate"; confirm if you
    meant "more than 2"). The
    prototype does not yet implement this collation (it only has break-out or badge), so the
    collated failed row and its expanded state need design and a mock first. Open sub-question:
    do failed runs age out of the broken-out set (for example only the latest N or those since
    the user last looked), or does the row stay until archived?
  - `?runs=many` stress-tests the rule (7 pending, 27 and 24 finished runs).
- **What this means for the code** (not yet verified against a built version):
  - The product today puts automation threads under one collapsed **Automations** disclosure
    per workspace (`projects-pane.ts` `renderAutomationsSection`, `ui-taste.md` "Automation
    threads"), which expands by itself when a run needs attention. The prototype's fold
    **replaces that disclosure** in the thread browser, so `ui-taste.md` must be rewritten and
    the `automation-*` e2e specs and `automation-settings-link` behaviour re-checked.
  - `activity-model.ts` has no automation awareness today (no `automation` or `scheduleId`
    reference), so the Activity list shows every run as an ordinary row. Fold logic belongs in
    the shared row model (built in this slice) as a pure function over rows, keyed by
    `thread.automation?.scheduleId`, so the sidebar and Activity list cannot drift. This is
    part of this slice's 4-5.5 days.
  - The settings link, **Run now** and **Automation setup** row actions need a home on the fold
    row; the prototype only shows a header menu entry (Automations, New automation).
  - A project's threads reach `getSidebarThreads` when it is opened or when the background
    preload after startup (`preloadSidebarThreads`) has read it, so folds cover those projects;
    SSH projects are not preloaded.
- Specs that this slice can break and must be re-run: `thread-sidebar-live-sort.e2e.ts`,
  `projects-remove-sidebar.e2e.ts`, `ssh-projects-pane.e2e.ts`, `projects-drag-*.e2e.ts`,
  `thread-sidebar-*.e2e.ts`, `views/projects-pane-*.test.ts`.
- Risk: medium. `projects-pane.ts` is a 1,881-line closure; extract the section you touch
  rather than adding to it.

### 5. (Dropped) Thread drag

Dragging a thread between projects is unsupported for now. Numbering is kept so slice 6 and 7
references stay stable.

### 6. Answer questions in place (2.5-4 days)

- Today a `needs-answer` row only offers "Answer in thread". Render the question and quick
  answers in the detail pane, sent through the ask-user dialog's own queue.
- Conflicts with `ui-taste.md` ("list rows carry no buttons", "Approve once is the only
  in-place grant"); amend it with the reasoning.
- Risk: high (permissions-adjacent). Full `pnpm run check`; read
  `docs/shell-permissions.md` only if the approval path changes.

### 7. Panel and composer polish (2 days)

- Right and bottom panel visuals, narrow widths (320 px), light theme, context ring.
- Mostly CSS. Do not rebuild the pane contents; the real panes already exist.
- **Context ring, last (decided 2026-10-04).** [#3407](https://github.com/copse-dev/agent-pane/pull/3407)
  merged (one ring, one hover) and [#3515](https://github.com/copse-dev/agent-pane/pull/3515) is
  open on top of it. Do this item last: re-read the prototype's ring against what shipped and port
  only the differences. The prototype's design workshop (`prototypes/combined-usage/index.html`) was
  the source for #3407, so start there.

**Total: about 17.5-26.5 focused days (sum of the slice ranges), or 4-6 calendar weeks.** Calendar time runs 1.5-2.5x focused
effort (CI cycles, merging main, screenshot review). Slices 4 and 6 are independent of 3 and can
run in parallel once slices 1 and 1b are merged. Add 0.25-0.5 day to any slice that changes the
IPC surface (API protocol version bump).

## Validation per slice

- Unit tests for every pure function (model, sort, group, tree move).
- `pnpm run oracle -- --explain`; run the full `pnpm run check` for slices 1b, 3 and 6 (cross-
  cutting or permission-adjacent), `check:local` plus focused tests elsewhere only if the
  oracle reports HIGH confidence.
- Visual evidence per slice as above, dark and light.

## Risks

- **Scope.** The prototype mixes a screen, a sidebar redesign and a restyle. Slices keep them
  separate so each can be reviewed and reverted alone.
- **Prototype drift.** [#3450](https://github.com/copse-dev/agent-pane/pull/3450) is a design
  reference, not a spec. Interactions it lists as not verified (real drag, resize, hover states,
  Memories search, Changes file picker, Browser menu, light thread view) need real verification.
- **Churn on `projects-pane.ts`.** Any parallel work on the sidebar conflicts with slice 4.
- **Screenshot baselines.** Slice 3 changes the new-thread screenshots in at least two specs;
  expect a reference-PNG review.

## Validation findings

Four checks run 2026-10-02. Raw bench output was in `$TMPDIR`; nothing in the product tree changed.

1. **Render cost measured** (slice 1b table). The sidebar rebuild is cheap; the plan's original
   performance premise was wrong, so 1b shrank. Caveat: happy-dom, not Chromium.
2. **Layout spike** (static mock, dark and light): layout A (docked composer, list above)
   works at 320, 720 and 1200 px with 0, 1 and 12 rows. Layout B (list above a centred
   composer) makes the composer jump (its top moved between 326, 317 and 500 px at 320 px wide
   as rows arrived) and collapses into A at 12 rows. Keyboard focus was reasoned, not driven.
   Only four of the combinations were captured.
3. **Claims audit** against the code: confirmed the rebuild, closures, bottom position, drag
   and in-place-answer gaps; corrected the sort location, the spec list and the doc conflicts
   (all folded into the slices above).
4. **Estimate calibration** from [#3386](https://github.com/copse-dev/agent-pane/pull/3386)
   (16 commits, 7 merges of main, 8 of 13 CI runs failed: 4 on the API-protocol gate, 3 on
   demo specs assuming the old pane) and [#3148](https://github.com/copse-dev/agent-pane/pull/3148)
   (additive, clean review, still 3 calendar days). Estimates were raised accordingly.
   The failure causes come from CI step names and PR comments, not the logs.

Update 2026-10-03: the prototype's automation fold (see slice 4) answers the Automations
question. Failed runs: break out; two or more from one schedule collate into one row.

Still unverified: layout and paint cost in Chromium, real keyboard behaviour of the new
screen, whether the API protocol gate fires for the
settings keys.

## Decisions (resolved)

1. Reverse "overlay, not screen": **yes**. One renderer, two hosts.
2. Thread drag between projects: **unsupported for now**; slice dropped.
3. Sort and group-by: **persisted**, per profile.
4. Attention colour: **fixed**; no token, no `?attn=` equivalent.
5. Activity group headers: **collapsible** in slice 3 (chevron button, `aria-expanded`).
6. Activity primary button label: **"Approve"** (the prototype's wording is intentional), with the
   same once-only behaviour. Lands with slice 3.
