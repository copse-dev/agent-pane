# UI taste & appearance notes

Hard-won appearance/layout conventions for the Copse renderer (`src/renderer`). This is a living
"taste" file: when a UI tweak teaches us something worth remembering, add it here so the next agent
doesn't relearn it. It complements — not replaces — the visual-eval rules in
[`AGENTS.md`](../AGENTS.md) and the markdown invariants in
[`src/renderer/markdown/README.md`](../src/renderer/markdown/README.md).

## Design tokens, not magic numbers

All spacing, radii, colors, and fonts come from CSS custom properties in
[`src/renderer/styles/tokens.css`](../src/renderer/styles/tokens.css). Reach for a token before
typing a raw pixel value; if you find yourself writing `padding: 8px 20px`, that's a smell.

| Token          | Value | Token              | Value |
| -------------- | ----- | ------------------ | ----- |
| `--spacing-xs` | 4px   | `--radius`         | 4px   |
| `--spacing-sm` | 8px   | `--radius-lg`      | 8px   |
| `--spacing-md` | 12px  | `--font-size-sm`   | 12px  |
| `--spacing-lg` | 16px  | `--font-size-base` | 14px  |
| `--spacing-xl` | 24px  | `--font-size-lg`   | 16px  |

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

## Prove visual changes with a focused e2e eval

Per `AGENTS.md`, any user-visible change needs a focused WebdriverIO Electron spec that seeds the
target state, asserts the DOM/layout behavior, and saves a screenshot — not just `npm run check` or a
manual VNC glance.

- For the footer fix, [`tests/e2e/settings-footer.e2e.ts`](../tests/e2e/settings-footer.e2e.ts)
  scrolls content beneath the bar and asserts (a) the footer's bottom is flush with the scrollport
  bottom (gap ≤ 1px) and (b) `elementFromPoint` at the bottom edge resolves to the footer, not
  scrolled-through content.
- Validate a layout-invariant test by confirming it **fails** on the pre-fix CSS, then **passes**
  with the fix. The footer spec failed with `gap=24px` before the fix.
- Run with the mock LLM and no keys: `COPSE_PANEL_MOCK_LLM=1 ANTHROPIC_API_KEY= OPENAI_API_KEY= npm run test:e2e -- --spec <spec>`.
- Reference screenshots that include a surface you changed (e.g. the settings footer appears in
  `settings-model-routing` shots) should be regenerated so they stay accurate.
- Pin `#app` to `window.innerWidth` in [`tests/e2e/helpers/screenshot.ts`](../tests/e2e/helpers/screenshot.ts)
  (`prepareE2eScreenshot`) so captures are not wider than the Electron window — otherwise table
  columns clip off the right edge of the PNG.
