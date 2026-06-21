# Markdown rendering

Hand-rolled renderer in `renderer.ts` used by conversation messages, subagent timelines, file
preview, and streaming (`streaming.ts`). Not a markdown library — keep it that way unless
requirements clearly outgrow it.

## Design invariants

When extending the renderer or its CSS, preserve these rules:

- **Valid block HTML.** Block elements (`<ul>`, `<ol>`, `<h3>`, `<h4>`, `<pre>`, `<table>`,
  `<hr>`) must never end up inside `<p>`. Mixed single-newline blocks (heading → subheading → list)
  are common in LLM output; split at block boundaries before wrapping paragraphs.
- **Inline formatting order.** Fenced code → inline code → bold → italic. Italic (`_` and `*`) runs
  only outside `<code>` spans and must not match across newlines (or `* list` lines get eaten).
- **Agent-output shapes.** Support `-`, `*`, and `+` list markers. Map `#`/`##` to `<h4>`, `###` to
  `<h3>` — h1/h2 are intentionally too large for the narrow pane.
- **List indent.** Global `* { padding: 0 }` strips UA list padding. Restore readable indent on
  `.message-text ul/ol` in `global.css` (currently `padding-inline-start: 1.5em;
list-style-position: outside`). Bullets should sit clearly inset from headings, not flush with
  them.
- **Subagent explore cards.** Render markdown in the timeline via `renderMarkdown` (see
  `conversation.ts`). The collapsed summary preview also renders markdown, but is hidden when the
  card is expanded — the timeline is the single source of truth; never show truncated raw `## …`
  text.
- **Fixtures over toy examples.** E2e seeds should mirror real agent summaries (multi-section
  headings + lists, explore subagent with `` `snake_case` `` tool names), not single-line `- foo`.
- **Mermaid diagrams.** Fenced ` ```mermaid ` blocks render as SVG via lazy-loaded `mermaid`
  (`mermaid.ts`). Diagram rendering runs after final markdown insertion (`message_done`, thread
  restore) — not on every streaming token. Fenced blocks are extracted before HTML escaping; prose
  markdown (bold, lists, headings) must not run inside diagram `<pre>` tags (`mapOutsideFencedHtml`).
  Before render, `prepareMermaidSource` / `mermaidSourceCandidates` decode entities and quote brittle
  `[labels]`. We call `mermaid.run` directly (no pre-parse gate — parse rejects some diagrams that
  still render). On failure after an aggressive retry, show the inline source fallback.

Prefer structural unit tests on HTML output plus WDIO geometry checks over pixel-diff screenshot CI.
E2e specs live in `tests/e2e/*.e2e.ts` (WebdriverIO) — not Playwright.

## Regression

CI runs `npm run check` + `npm run build` + `npm run test:e2e`. After changing `renderer.ts`,
`conversation.ts`, or `.message-text ul/ol` styles, also run:

```bash
npm run build
npm run test:e2e:markdown
```

### Unit tests (`renderer.test.ts`, via `npm test`)

- No `<ul>` nested inside `<p>` for multi-section agent summaries
- `*italic*` and `` `snake_case` `` code spans stay intact (no cross-line `<em>` bleed)
- Explore-style fixtures: `##`/`###` headings, `<hr>`, and lists as sibling block elements

### E2e tests (seeded via `tests/e2e/helpers/seed-config.ts`)

- `tests/e2e/markdown-list-indent.e2e.ts` — Known Failures + Architecture Highlights; asserts list
  text is inset >4px from headings
- `tests/e2e/semantic-search-markdown.e2e.ts` — explore subagent timeline; asserts no raw `##` in
  rendered text, summary preview hidden when expanded, code spans intact
- `tests/e2e/mermaid-diagram.e2e.ts` — seeded flowchart; asserts `.mermaid-diagram svg` renders

Screenshots under `tests/e2e/screenshots/` (`markdown-list-indent-*.png`, `semantic-search-*.png`)
are updated by those specs for human review; CI asserts DOM layout, not pixels.
