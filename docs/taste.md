# UI taste (renderer CSS)

Guidance for agent-generated UI in the chat pane — tables, lists, tool cards, and
other `.message-text` content. The renderer cannot predict every LLM table shape, so
CSS should use **layout mechanics**, not **layout guesses**.

## Tables in markdown

Styles live in `src/renderer/styles/global/markdown.css`. Regression fixtures:
`tests/e2e/markdown-table-wrap.e2e.ts`, `tests/e2e/markdown-bold-glob.e2e.ts`.

### Do

- **Fit the pane first.** `width: 100%`, `max-width: 100%`, `table-layout: auto`.
  Prefer wrapping and column shrink over horizontal scroll. Reserve `overflow-x: auto`
  for genuinely unbreakable cell content (e.g. a long hash with no break points).
- **Reset inherited message styles on cells.** `.message-text` uses `white-space:
  pre-wrap`; table cells must set `white-space: normal` (and usually `min-width: 0`)
  or short values like `296` and `DRAFT` break mid-token.
- **Shrink edge columns with content, not magic widths.** For tables where short
  values sit on the edges, use the standard pattern:

  ```css
  th:first-child,
  td:first-child,
  th:last-child,
  td:last-child {
    width: 1%;
    white-space: nowrap;
  }
  ```

  `width: 1%` tells the engine “as narrow as content allows”; middle columns take the
  rest. Scope with a structural guard (e.g. `:has(th:nth-child(4))`) when a rule would
  otherwise harm two-column tables.
- **Let long inline code wrap inside the cell.** Lone `<code>` in a cell:
  `display: block`, `min-width: 0`, `max-width: 100%`, `overflow-wrap: anywhere`.

### Don't

- **Don't hardcode column widths** (`2.75rem`, `4.75rem`, `34%`, `20ch`, etc.) to
  match one fixture (PR lists, file paths, etc.). Those values go stale on the next
  agent table and fight different pane widths.
- **Don't force horizontal scroll** (`min-width: max-content`, `width: max-content` on
  the table) unless overflow is truly unavoidable — users asked to avoid scroll for
  normal agent tables.
- **Don't encode column semantics in CSS** when the markdown has no hooks (no
  `col`/`data-*`/header text). If a column needs special treatment beyond “edge vs
  middle”, fix it in the renderer or accept a generic rule — don't maintain a growing
  list of nth-child width hacks.

### Acceptable heuristics

Structural selectors tied to **table shape**, not **content meaning**, are OK when
generic rules aren't enough:

- `:has(th:nth-child(4))` — “four or more columns; first/last are probably narrow
  labels”
- `td > code:only-child` — “cell is just a slug/path”

Avoid `:nth-child(3) { width: 34% }` and similar “column 3 is always Branch” rules.

## Visual evals

Any change here needs a focused WDIO spec + screenshot (see `AGENTS.md` and
`.cursor/skills/screenshot-validate/SKILL.md`). Pin `#app` to `window.innerWidth` in
`tests/e2e/helpers/screenshot.ts` so captures are not wider than the Electron window.
