# UI taste & appearance notes

Hard-won appearance/layout conventions for the Copse renderer (`src/renderer`). This is a living
"taste" file: when a UI tweak teaches us something worth remembering, add it here so the next agent
doesn't relearn it. It complements — not replaces — the visual-eval rules in
[`AGENTS.md`](../AGENTS.md) and the markdown invariants in
[`src/renderer/markdown/README.md`](../src/renderer/markdown/README.md).

## Attached screenshot expand

Thread message images (`.message-image`) and roadmap plan image chips
(`.roadmap-attachment-thumb`) open the shared lightbox in
[`src/renderer/attachments/image-expand.ts`](../src/renderer/attachments/image-expand.ts)
(`dialog.image-expand-dialog`). Wire new attachment thumbs through
`attachImageExpand` rather than inventing a second overlay. Visual eval:
[`tests/e2e/image-expand.e2e.ts`](../tests/e2e/image-expand.e2e.ts).

### Native `<dialog>` and `display`

Never set `display: flex` (or any `display`) on a `<dialog>` without scoping it to
`dialog[open]`. Author `display` outranks the UA `dialog { display: none }`, so
`close()` exits the top layer but the node stays painted in the page — typically a
ghost lightbox showing the cleared image’s alt (“Expanded attachment”) and Close.
`forms.css` forces `dialog:not([open]) { display: none !important; }` as a backstop
(same idea as `[hidden]` in `base.css`). Put flex layout on an inner shell when you
can; when the dialog itself must flex, use `.foo-dialog[open] { display: flex; }`.

## Design tokens, not magic numbers

All spacing, radii, colors, and fonts come from CSS custom properties in
[`src/renderer/styles/tokens.css`](../src/renderer/styles/tokens.css). Reach for a token before
typing a raw pixel value; if you find yourself writing `padding: 8px 20px`, that's a smell.

Interface scale (`--ui-scale`, Settings → Appearance, ⌘+/−/0, trackpad pinch) multiplies the
font-size and spacing tokens (and chrome band heights) via `calc(… * var(--ui-scale))`. Radii,
layout max-widths, and `--traffic-light-inset` stay unscaled so OS chrome alignment does not drift.
Prefer tokens over hardcoded `px` so scale reaches the surface. Helpers live in
[`src/shared/ui-scale.ts`](../src/shared/ui-scale.ts); the renderer applies the var through
[`src/renderer/dom/ui-scale.ts`](../src/renderer/dom/ui-scale.ts).

| Token          | Base | Token              | Base |
| -------------- | ---- | ------------------ | ---- |
| `--spacing-xs` | 4px  | `--radius`         | 6px  |
| `--spacing-sm` | 8px  | `--radius-lg`      | 8px  |
| `--spacing-md` | 12px | `--font-size-sm`   | 12px |
| `--spacing-lg` | 16px | `--font-size-base` | 14px |
| `--spacing-xl` | 24px | `--font-size-lg`   | 16px |

Chrome band tokens (not spacing, but reach for these before inventing heights):
`--chrome-action-band-height`, `--browser-chrome-band-height`.

- There is no spacing token larger than `--spacing-xl` (24px). When you genuinely need more, compose
  with `calc()` from existing tokens (e.g. `calc(var(--spacing-xl) + var(--spacing-lg))`) rather than
  introducing a new magic number. This mirrors what `onboarding.css` already does.
- Colors: `--bg-base` / `--bg-elevated` / `--bg-hover`, `--text-primary` / `--text-secondary` /
  `--text-muted`, `--border`, `--accent`, and the `--error` / `--success` / `--warning` status hues.
- Per user preference: before adding any constant, check whether one already exists to import/use.
- Column widths in markdown tables are magic numbers too — see **Markdown tables in chat** below.

## Markdown tables in chat

Agent-generated GFM tables live in `.message-text`; styles in
[`src/renderer/styles/global/markdown.css`](../src/renderer/styles/global/markdown.css). The renderer
cannot predict every table shape, so use **layout mechanics**, not **layout guesses**. Regression
fixtures: [`tests/e2e/markdown-table-wrap.e2e.ts`](../tests/e2e/markdown-table-wrap.e2e.ts),
[`tests/e2e/markdown-bold-glob.e2e.ts`](../tests/e2e/markdown-bold-glob.e2e.ts).

### Do

- **Fit the pane first.** `width: 100%`, `max-width: 100%`, `table-layout: auto`. Prefer wrapping
  and column shrink over horizontal scroll. Reserve `overflow-x: auto` for genuinely unbreakable cell
  content (e.g. a long hash with no break points).
- **Reset inherited message styles on cells.** Only `.message-text p` uses `pre-wrap` (CommonMark
  soft breaks); the message container itself is `white-space: normal` so HTML newlines between block
  elements do not stack on margins. Table cells must still set `white-space: normal` (and usually
  `min-width: 0`) or short values like `296` and `DRAFT` break mid-token.
- **Shrink edge columns with content, not magic widths.** For tables where short values sit on the
  edges, use the standard pattern:

  ```css
  th:first-child,
  td:first-child,
  th:last-child,
  td:last-child {
    width: 1%;
    white-space: nowrap;
  }
  ```

  `width: 1%` tells the engine “as narrow as content allows”; middle columns take the rest. Scope
  with a structural guard (e.g. `:has(th:nth-child(4))`) when a rule would otherwise harm two-column
  tables.

- **Let long inline code wrap inside the cell.** Lone `<code>` in a cell: `display: block`,
  `min-width: 0`, `max-width: 100%`, `overflow-wrap: anywhere`.

### Don't

- **Don't hardcode column widths** (`2.75rem`, `4.75rem`, `34%`, `20ch`, etc.) to match one fixture
  (PR lists, file paths, etc.). Those values go stale on the next agent table and fight different
  pane widths.
- **Don't force horizontal scroll** (`min-width: max-content`, `width: max-content` on the table)
  unless overflow is truly unavoidable.
- **Don't encode column semantics in CSS** when the markdown has no hooks (no `col`/`data-*`/header
  text). If a column needs special treatment beyond “edge vs middle”, fix it in the renderer or
  accept a generic rule — don't maintain a growing list of nth-child width hacks.

### Acceptable heuristics

Structural selectors tied to **table shape**, not **content meaning**, are OK when generic rules
aren't enough:

- `:has(th:nth-child(4))` — “four or more columns; first/last are probably narrow labels”
- `td > code:only-child` — “cell is just a slug/path”

Avoid `:nth-child(3) { width: 34% }` and similar “column 3 is always Branch” rules.

For primary/secondary action buttons (Save / Cancel style):

- Give buttons a roomy hit area — `padding: var(--spacing-md) var(--spacing-xl)` reads better than a
  cramped `8px 20px`.
- Separate buttons with `gap: var(--spacing-md)`, not a tight `--spacing-sm`.
- Keep an action bar clear of the window's bottom edge. Don't let buttons sit flush against the
  bottom; add generous bottom spacing (e.g. `calc(var(--spacing-xl) + var(--spacing-lg))`).
- Inline row actions (Edit / Remove on a list row) need an explicit flex container with
  `gap: var(--spacing-md)`. Without it, adjacent text buttons render as one jammed word
  (`EditRemove`) — see `.ssh-host-row-actions` in `ssh-workspace.css`.

## Text selection: content is selectable, chrome is not

Copse is a desktop app, so its window chrome (tabs, sidebars, labels, footers, dialog buttons)
should behave like native chrome — dragging across it must **not** highlight text. But the agent's
output is content the user will legitimately want to copy. The policy, enforced in
[`base.css`](../src/renderer/styles/global/base.css):

- `<body>` defaults to `user-select: none`, so nothing is selectable unless it opts back in. This is
  a **default-deny** model: new UI is non-selectable for free, and you only think about selection
  when you're adding a region that holds copyable content.
- One rule re-enables `user-select: text` on the content regions: inputs the user authors
  (`input`, `textarea`, `select`, `[contenteditable]`), rendered markdown
  (`.message-text`, `.message-reasoning-text`), tool output (`.tool-result`, `.tool-args pre`), the
  terminal (`.terminal-container`), and the editor (`.monaco-editor .view-lines`).

### The test to apply

Ask "is this **content** the agent produced (or the user typed), or is it **chrome**?"

- **Content → selectable.** Every markdown-rendering surface must land in a container carrying
  `.message-text` (the review card, PR description, and file preview all do this by composing the
  class) or be added to the selection allow-list explicitly, as `.message-reasoning-text` is.
- **Chrome → not selectable.** This includes the permission prompt (`.approval-body`). It reads like
  content — it can even show the shell command about to run — but it's a transient modal asking a
  yes/no question, not part of the transcript. It stays out of the allow-list. (If a future need to
  copy the pending command arises, add a dedicated copy affordance rather than making the whole
  prompt drag-selectable.)

When you add a new markdown-rendering surface, either compose `.message-text` onto its container or
add its class to the allow-list in `base.css` — otherwise the agent's output silently can't be
copied. The contract test
[`src/renderer/styles/text-selection.test.ts`](../src/renderer/styles/text-selection.test.ts) pins
the policy: body defaults to non-selectable, the content regions opt back in, and the permission
prompt stays non-selectable.

## Sticky footers inside scroll containers (gotcha)

A `position: sticky; bottom: 0` element **cannot extend past its containing block's content box**.
So if the scroll container has bottom padding, the sticky footer stops short by exactly that padding,
leaving a gap underneath where scrolled content shows _through / past_ the footer.

Rules of thumb:

- Put the scroll container's bottom breathing room **inside the sticky footer** (as the footer's own
  `padding-bottom`), not as `padding-bottom` on the scroll container.
- The sticky footer needs an opaque `background` (`var(--bg-base)`) so content scrolling beneath it is
  actually covered.
- Alternatively, mirror the onboarding pattern: make the footer a non-scrolling flex sibling
  (`flex-shrink: 0`) _outside_ the scroll region (see `onboarding.css` / `onboarding-dialog.ts`).
  Prefer this when the footer doesn't need to live inside a `<form>` for submit semantics.

### Worked example — Settings Save/Cancel bar

Symptom: while scrolling Settings, fieldset content was visible _past_ (below) the Save/Cancel bar.

Root cause: `.settings-buttons` is `position: sticky; bottom: 0` inside the scrollable
`form.settings-content`, which had `padding: var(--spacing-xl)` on all four sides. The 24px bottom
padding left a 24px gap below the sticky bar.

Fix (in [`src/renderer/styles/global/settings.css`](../src/renderer/styles/global/settings.css)):

- Drop the scroll container's bottom padding: `padding: var(--spacing-xl) var(--spacing-xl) 0`.
- Move that breathing room into the footer and lift it off the window edge:
  `padding-bottom: calc(var(--spacing-xl) + var(--spacing-lg))`.
- Roomier buttons: `padding: var(--spacing-md) var(--spacing-xl)`, `gap: var(--spacing-md)`.

The scroll surface (`.settings-content`) stays **full width** beside the nav — do not put
`max-width` on the scroller itself. Cap and center the form column (sections, search results,
Save/Cancel) with `width: min(100%, var(--settings-content-max)); margin-inline: auto`, the same
split chat uses for `.messages-list` / `.msg`.

## Markdown prose spacing in chat

Symptom: assistant messages look “double spaced” — extra blank lines between headings, paragraphs,
and lists even when the markdown source only has one blank line.

Root cause: `white-space: pre-wrap` on `.message-text` makes **HTML source newlines between block
tags** (`</p>\n<h3>`, `</ol>\n<ul>`) render as visible blank lines _on top of_ block margins.

Fix (in [`conversation.css`](../src/renderer/styles/global/conversation.css)):

- `.message-text { white-space: normal }` — block boundaries use margins only.
- `.message-text p { white-space: pre-wrap }` — CommonMark soft breaks inside a paragraph still
  show as line breaks.
- Lists/tables already reset to `white-space: normal` on `ul`/`ol`/cells.

Do not put `pre-wrap` back on the message container “for convenience”; it regresses every multi-block
agent summary.

## Remote folder breadcrumbs

In the Open remote folder dialog, the root crumb's label is `/`. Do **not** also render a `/`
separator after it — that paints `/ / usr` for `/usr`. Skip the separator when
`segment.path === '/'` (`remotePathShowsSeparatorAfter` in
[`remote-folder-path.ts`](../src/renderer/views/remote-folder-path.ts)). Specs:
[`remote-folder-path.test.ts`](../src/renderer/views/remote-folder-path.test.ts),
[`tests/e2e/remote-folder-breadcrumbs.e2e.ts`](../tests/e2e/remote-folder-breadcrumbs.e2e.ts).

## SSH project sidebar labels

SSH projects in the projects pane use `hostLabel:/full/remote/path`, not `hostLabel:basename`.
Two remotes ending in the same leaf (e.g. `/etc/ddg` and `/home/ubuntu/ddg`) must stay
visually distinct. Display re-derives from `project.path` so older basename-only stored
names still render correctly (`projectDisplayName` in
[`projects.ts`](../src/renderer/controller/projects.ts)).

## Thread GitHub PR status icon

Sidebar `.chat-row`s that link to GitHub PRs (chat URLs and/or `remoteAgentLink.prUrl`)
show a single git-pull-request icon after lifecycle resolves — not text, not a pill:

- open → accent
- merged → success
- closed → muted

The tooltip / `aria-label` carries the detail (`#42 is open`, `all merged`, …).
Logic lives in [`thread-pr-status.ts`](../src/shared/git/thread-pr-status.ts). Specs:
[`projects-pane-pr-status.test.ts`](../src/renderer/views/projects-pane-pr-status.test.ts),
[`tests/e2e/thread-pr-status.e2e.ts`](../tests/e2e/thread-pr-status.e2e.ts).

## SSH chrome — plain text, no decorative emoji

The titlebar SSH target is plain `user@host` (`.workspace-ssh-target`), not `⚡ user@host`.
Status banners are text (+ actions) only — no ⚡/⚠ icons. Capability warnings come from the
boolean flags once each (`inotifywait not found…`), never duplicated with probe `warnings[]`.
Specs: [`ssh-status-banner.test.ts`](../src/renderer/views/ssh-status-banner.test.ts),
[`tests/e2e/ssh-titlebar-target.e2e.ts`](../tests/e2e/ssh-titlebar-target.e2e.ts).

## To-dos panel: cancelled means gone

The inline To-dos panel (`todo-panel.ts`) lists the **active plan only**. Cancelled items
are omitted from the DOM (same product read as ACP plans: cancelled = no longer part of the
plan). When every item is cancelled — or the thread has no todos — hide the panel entirely;
do not leave a `0/0 done` shell with struck-through or muted ghost rows. Strikethrough is for
**completed** work, not cancelled work. Spec:
[`tests/e2e/todo-display.e2e.ts`](../tests/e2e/todo-display.e2e.ts).

## Centered new-thread composer: one hairline, not two

Empty threads float `#input-bar` via `.pane-chat.composer-centered`. The docked composer keeps a
real CSS `border: 1px solid var(--border)`; the centered variant must **clear the full border**
(`border: none`) and paint its perimeter only with `box-shadow: 0 0 0 1px var(--border)`. Clearing
just `border-top` leaves left/right/bottom borders stacked under that ring — a thicker, uneven
outline. Specs: `modern-css.test.ts`, `tests/demo/chat-layout-styling.demo.ts`.

## Browser Tabs header and URL toolbar share one chrome band

In browser mode the left `.browser-tabs-list-header` ("Tabs") and the right `.browser-toolbar`
(URL bar) sit side by side across the tree resizer. Their **bottom borders must meet as one
continuous line** — same shared `--browser-chrome-band-height` token, no extra
`border-top` on `.browser-viewer-host` (that hairline framed an L against the sidebar and
pushed the toolbar out of band; same trap as `.terminals-viewer-host`). Spec:
[`tests/e2e/browser-display.e2e.ts`](../tests/e2e/browser-display.e2e.ts).

## Portrait / vertical chrome (narrow tall windows)

On tall portrait windows (or when the right panel is pinned to **bottom**), keep mode switching
reachable without a crowded titlebar:

- Titlebar keeps **Open in editor** + **Panel** labeled; secondary mode buttons (Terminal, Changes,
  PRs, Browser, …) become icon-only.
- A labeled `.portrait-panel-bar` sits under `.input-footer` (between status and the stacked panel),
  matching the Settings button height band and spanning the chat column. Mount it on `.pane-chat`,
  not inside the floating `#input-bar`, so it can dock to the actual thread/panel seam.
- The whole mode strip uses one open-bottom outline, sized to the floating chat composer; individual
  mode buttons stay unboxed. Give those buttons near-band-height hit targets and `--spacing-sm`
  horizontal padding even though their visual treatment remains light. The strip rests directly on
  the horizontal resizer, which is the sole one-pixel divider in the stacked layout — do not add a
  second top border to `.pane-files`.
- When the chat column is too narrow for every labeled mode, trailing buttons collapse into a `…`
  overflow menu (Panel stays visible; same idea as the footer compact overflow) rather than wrapping
  or scrolling. Spec:
  [`tests/e2e/portrait-panel-controls.e2e.ts`](../tests/e2e/portrait-panel-controls.e2e.ts).

## Tool actions: past when settled, progressive while running, one rollup per turn

Tool-call chrome in the transcript should stay quiet — muted inline text, not a stack of
elevated boxes. Conventions (owned by `tool-display.ts` + `tool-cards.css`):

- **Tense follows status.** Progressive while any member is `running` (`Reading files`,
  `Using 3 tools`, activity line `Listing directory…`); past once settled (`Read files`,
  `Used 3 tools`, `Listed directory`). Do not paint a finished past-tense label on a live
  tool, and do not keep progressive wording on a completed card.
- **One rollup for the turn.** Two or more non-subagent tool calls on a message collapse into
  `.tool-card-rollup`. The collapsed summary is **italic muted text** (like reasoning) — click
  to expand nested category groups and individuals. Subagent cards stay outside the rollup.
- **Reasoning nests with its tools.** When a segment has both `reasoning` and tools, do **not**
  render a standalone Reasoning block above the rollup. Put it inside the expanded rollup
  body (above the tool rows) so the collapsed view is only the italic heading. Standalone
  Reasoning remains for answer-only / no-tool segments. Title tense matches tools:
  `Reasoning` while live, `Reasoned` when settled.
- **Say Reasoning, not Thinking.** The disclosure and activity row use `Reasoning` /
  `Reasoned` / `Reasoning…` — clearer about the model step, and aligned with the
  `reasoning` field / provider events.
- **Canned first, small-model polish later.** Show the deterministic label immediately
  (`Used N tools` / `Read files`). A non-blocking small-tasks call may replace it with
  `message.toolSummary` (e.g. “Read the settings UI”) when ready — never delay the turn on
  that call. Keep failure callouts (`· N failed`) even after polish.
- **No card chrome by default.** Collapsed tool rows drop fill/border; nested items inside an
  expanded rollup stay flat under a hairline indent. Reach for `--text-muted` / italics on the
  rollup summary, not `--bg-elevated` panels.

Specs: `src/shared/tools/tool-display.test.ts`, `src/renderer/views/tool-display.test.ts`,
`tests/e2e/tool-display-rollup.e2e.ts`, `tests/e2e/browser-tools.e2e.ts`.

## Hook cards are a distinct card family — right-aligned, blue, not a user message

Hook executions, deny/ask decisions, and halts (decision 10 of
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md)) render as a tool-call-style
card family in [`hook-cards.css`](../src/renderer/styles/global/hook-cards.css). Hard-won conventions:

- **"Same blue" is the user-message accent, not a new hue.** Hook cards fill with `--accent-soft`
  (the exact fill `.msg-user` uses) and a `color-mix(--accent …)` hairline. Reach for the existing
  accent token — do **not** introduce a hook-specific colour. The zap glyph (`.hook-card-icon`) stays
  `--accent` even when a status tints the row, so the family reads as one thing.
- **Right-aligned means the host aligns, the card constrains its width.** `.hook-card-host` is a flex
  column with `align-items: flex-end`; each `.hook-card` sets `max-width: min(80%, 460px)`. A
  full-width card would not read as "right-aligned" no matter the `align-self`. This is what visually
  separates hook cards (machine-side, right) from the left-flowing assistant/tool content.
- **Render hook cards as the anchor message's next sibling, never nested in the bubble.** Hook runs
  anchor to the message they fired within (the user turn that started them, since the assistant
  message finalizes later — see `attachHookCards` in `fold.ts`). Nesting a blue card inside the
  (also-blue) `.msg-user` bubble muddies both; the sibling `.hook-card-host` after the message keeps
  the family distinct. This mirrors how inline review cards sit as `msgEl.after(card)`.
- **Status tints the glyph + hairline, not the fill.** A blocking verdict (`deny` / `blocked` /
  `error` / `halted`) turns the status icon + border `--error`; `ask` / `halt-suppressed` use
  `--warning`; `allow` / `ok` use `--success`. The card keeps its blue family fill throughout — the
  status is a signal, not a re-skin. A sandbox block or a function-hook throw always wins over a
  printed verdict (a hook can't paint itself "allowed", F3 / decision 9).
- **A hook-originated turn is marked, never disguised.** The message role stays `user` for the LLM,
  but `.msg-hook-origin-marker` (a small `--accent` label: `Hook · <id> (<Event>)`) sits above the
  body so it never reads as human-typed. A human edit surfaces an italic `edited` note — authorship
  stays honest (decision 10). Cards + marker resolve purely from spine data (`Message.hookCards` /
  `Message.origin`), never from live hook registration (decision 17), so history renders identically
  to the live run. Spec: [`tests/e2e/hook-cards.e2e.ts`](../tests/e2e/hook-cards.e2e.ts); DOM in
  [`src/renderer/views/hook-cards.test.ts`](../src/renderer/views/hook-cards.test.ts).

## Footer popovers: one boundary, distinct trigger anchors

Model, checkout, branch, overflow, and context-wheel popovers in `.input-footer` use the
positioned footer as their horizontal containing block, but each popup must keep its own trigger as
`position-anchor`. Give every footer control a distinct dashed-ident through
`--footer-popup-anchor`; do not reuse one literal `anchor-name` across sibling controls.
Chromium can resolve a duplicate name to another eligible footer anchor, which makes a menu jump
toward the end of the composer instead of opening above its control.

The shared rule in
[`input-bar.css`](../src/renderer/styles/global/input-bar.css) preserves each popup's natural
width and caps it at `100%` of the footer. All footer popovers share the local popup layer
(`z-index: 100`), above composer/footer chrome but below dialogs and global context menus. Controls
on the footer's left (model, checkout, and branch) align popup and trigger left edges, while controls
on the right (overflow and context wheel) align their right edges. Named `@position-try` fallbacks clamp a popup to `left: 0` or `right: 0`
only when its primary trigger alignment would overflow. Once the footer enters `is-compact`, disable
`position-try` and snap left-side menus left / right-side menus right; compact relayout must not make
Chromium repeatedly resolve anchor fallbacks. Keep collision sizing relative to the
positioned footer; cross-anchor `anchor-size()` dependencies can cycle at minimum pane widths. Do
not constrain both horizontal insets in the primary position, because that stretches wide-content
menus across the whole available interval. The focused
regression eval is
[`footer-overflow-bounds.e2e.ts`](../tests/e2e/footer-overflow-bounds.e2e.ts): it pins every
trigger/menu anchor pair, checks normal trigger alignment plus narrow-footer containment, and owns
the model-selector, normal overflow, and constrained overflow reference screenshots.

## Context menus (right-click)

App-chrome right-click menus use a fixed-position `.context-menu` / `.context-menu-item` pair (see
[`layout.css`](../src/renderer/styles/global/layout.css)), not the anchored `.browser-menu` wrap.
Pin to `clientX`/`clientY`, clamp into the viewport, and dismiss on outside pointerdown / Escape /
window blur. First use: project rows → **Remove from sidebar**
([`projects-pane.ts`](../src/renderer/views/projects-pane.ts)); visual eval
[`tests/e2e/projects-remove-sidebar.e2e.ts`](../tests/e2e/projects-remove-sidebar.e2e.ts).

In-app **browser guest pages** (`<webview>`) use a native Electron `Menu` from the main-process
`context-menu` event instead — guest content cannot host our DOM menu. Standard items live in
[`browser-context-menu.ts`](../src/main/windows/browser-context-menu.ts): Open Link in New Tab /
Copy Link Address, Copy Image / Copy Image Address / Save Image As…, Cut/Copy/Paste/Select All,
Inspect Element. Keep that set browser-like; do not reinvent it as a renderer `.context-menu`.

## Sources lists: origin on hover, not in the resting row

Settings → Sources rows already carry a coarse source badge (`bundled`, `project`, …). When the
useful origin is a long filesystem path, keep it out of the resting list: put it in
`.sources-row-hover-detail` inside the header gutter (between title and badge), revealed on
`:hover` / `:focus-within` without growing the row. Truncate with left-elision
(`direction: rtl` + `text-overflow: ellipsis`, same trick as `.git-change-path`) so the leaf
stays visible; mirror the full path on the row's `title` for the native tooltip. Spec:
[`tests/e2e/settings-sources-skills.e2e.ts`](../tests/e2e/settings-sources-skills.e2e.ts).

## Prove visual changes with a focused e2e eval

Per `AGENTS.md`, any user-visible change needs a focused WebdriverIO Electron spec that seeds the
target state, asserts the DOM/layout behavior, and saves a screenshot — not just `npm run check` or a
manual VNC glance.

- Primary-chat model labels (`.message-model`) appear only when a thread's assistant turns used more
  than one picker model — keep them muted chrome (`--font-size-xs`, tertiary text), never inside
  `.message-text`. The footer model picker shows the active route (including best-value auto-picks).
  Spec: [`tests/e2e/chat-multi-model-labels.e2e.ts`](../tests/e2e/chat-multi-model-labels.e2e.ts).
- For the footer / settings-column layout,
  [`tests/demo/settings-footer.demo.ts`](../tests/demo/settings-footer.demo.ts) asserts (a) the
  scroll panel fills the body beside the nav while the form column stays at
  `--settings-content-max`, (b) the footer's bottom is flush with the scrollport bottom (gap ≤ 1px),
  and (c) `elementFromPoint` at the bottom edge resolves to the footer, not scrolled-through content.
- Validate a layout-invariant test by confirming it **fails** on the pre-fix CSS, then **passes**
  with the fix. The footer spec failed with `gap=24px` before the fix.
- Run with the mock LLM and no keys: `COPSE_PANEL_MOCK_LLM=1 ANTHROPIC_API_KEY= OPENAI_API_KEY= npm run test:e2e -- --spec <spec>`.
- Reference screenshots that include a surface you changed (e.g. the settings footer appears in
  `settings-model-routing` shots) should be regenerated so they stay accurate.
- Pin `#app` to `window.innerWidth` in [`tests/e2e/helpers/screenshot.ts`](../tests/e2e/helpers/screenshot.ts)
  (`prepareE2eScreenshot`) so captures are not wider than the Electron window — otherwise table
  columns clip off the right edge of the PNG.

## Transcript status callouts

Review and comparison results should read as annotations in the transcript, not rounded cards or
pills. Use a square, thin status rail and a subtle horizontal color wash that fades into the chat
background. Reserve the rail hue for state (accent, error, etc.); avoid a full perimeter border,
rounded container corners, or a solid tinted block around these secondary results.

## Conditional split panes

Do not permanently reserve space for a secondary viewer that has no content yet. When a pane has a
primary summary and an optional detail surface (for example, PR description plus selected-file
diff), let the primary surface flex into the unused area. Restore the bounded split only once the
secondary content is loading or visible, and keep its selector adjacent to the expanded primary
surface so the next action remains discoverable.

## Accent colour versus interface tint

The accent and tint are separate controls. Accent is semantic interaction emphasis: links, primary
actions, focus, selected rows, and user-authored message highlights. Interface tint is only a subtle
wash through otherwise neutral surfaces. Derive hover and link shades from the accent per theme,
and derive foreground text from the chosen solid accent so custom colours do not leave primary
buttons unreadable. Do not introduce one-off component blues that bypass these tokens.

## Roadmap list rows

Roadmap backlog rows (`.roadmap-row` in
[`roadmap-pane.ts`](../src/renderer/views/roadmap-pane.ts) /
[`roadmap.css`](../src/renderer/styles/global/roadmap.css)) follow the same quiet
sidebar taste as thread rows and PR status icons:

- **Title first, one line.** Title on the left; trailing indicators on the right.
  No second meta row of chips under every title.
- **Hide the default state.** `ready` items show no status badge — the title is
  the signal. `done` is strikethrough on the title only (`.roadmap-row.is-done`),
  not a "done" pill. Only exceptional statuses (`blocked`, `conflicts`,
  `archived`) get a lowercase status chip.
- **Icons over labels.** Linked threads use the muted messages icon (tooltip /
  `aria-label` carries the thread title); attachments are a muted paperclip +
  count with no pill wash. Mark-done / reopen are check / refresh icons, hidden
  until row hover or focus (same idea as `.chat-delete`).
- **Palette matches.** Cmd/Ctrl+P roadmap hits follow the same hide-ready rule.

Spec: [`tests/e2e/roadmap-list-rows.e2e.ts`](../tests/e2e/roadmap-list-rows.e2e.ts).
Complexity / fit / review chips stay when present (they are rare); tuck those
further only if the list gets noisy again.

## Sidebar selections

Chat rows use flat, square, full-bleed selection and hover fills with a slim inset accent rail on
the **trailing (right) edge**. Avoid rounded row highlights here: they read like detached pills
instead of a selection within a continuous sidebar list. Don't reintroduce horizontal
`margin-inline` on `.chat-row` — the selection wash should span the sidebar edge-to-edge.

Thread rows and the paginated **Show more** control share the same horizontal inset
(`margin-inline: var(--spacing-xs)` plus `padding-left: 28px`). Don't give Show more `width: 100%`
without that margin — the label drifts left of the titles above it.

Settings nav (`.settings-nav-btn.active`) keeps a **leading** accent rail — that list sits on the
dialog's left edge, so the marker belongs there, not on the trailing side.

## Settings → Usage worth-it card

The plan worth-it block sits between subscription bars and the local ledger: one short verdict, one
fee field, one action that jumps to the value map’s Inference cost basis. Do not turn it into a
dashboard (no sparkline grids, no multi-provider scorecards in v1). Keep the fee control plain —
label + number input — and let verdict color come from `--success` / `--warning`, not custom hues.

## Explicit danger modes

A mode that materially relaxes routine confirmations must remain visible at the
point of action. Use a full-width, square composer strip with the shared `--danger`
token, plain containment copy, and an immediate Disable action; do not reduce it to
a transient toast, icon-only state, or rounded status pill. The opt-in warning must
name the scope, expiry, containment, and residual risk before activation. Visual
eval: `tests/e2e/guarded-yolo.e2e.ts`.

## Roadmap import picker rows

`.roadmap-import-row` is a `<label>` wrapping a checkbox + title. The global `label` rule in
`forms.css` sets `flex-direction: column`, so any row that only sets `display: flex` (without
`flex-direction: row`) stacks the checkbox under the title and — with `align-items: center` —
centers both. Always override `flex-direction: row` (and reset `margin-bottom`) on checkbox list
rows built from `<label>`. Visual eval:
[`tests/e2e/roadmap-import-picker.e2e.ts`](../tests/e2e/roadmap-import-picker.e2e.ts).
