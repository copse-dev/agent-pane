# Markdown rendering

Hand-rolled renderer in `renderer.ts` used by conversation messages, subagent timelines, file
preview, and streaming (`streaming.ts`). At-rest rendering routes through `tokenizeBlocks()` →
`renderBlocks()` (`render-blocks.ts`); block/inlined tokenizers in `block-tokenizer.ts`,
`inline-emphasis.ts`, and `streaming-split.ts` also drive streaming hold decisions (#475). It is
not a standalone markdown library, but we **do** treat the CommonMark spec as the reference for
block/inline structure and grow toward it incrementally (see conformance baseline below).

## Design invariants

When extending the renderer or its CSS, preserve these rules:

- **Sanitize at the sink.** `renderMarkdown()` is a pure string→HTML function, but
  its output assembles HTML by concatenation and is treated as untrusted. Every
  `innerHTML` assignment of rendered markdown goes through
  `sanitizeRenderedMarkdown()` (`sanitize.ts`, DOMPurify) first — see
  `conversation.ts`, `streaming.ts`, `context-panel.ts`. If you add a new sink or a
  new output tag/attribute, route it through the sanitizer and widen its allowlist
  to match. Mermaid SVG is produced after sanitization and is not re-sanitized.
  Rationale and the survey of streaming-parser alternatives live in
  `docs/plans/markdown-renderer-hardening.md`.
- **Valid block HTML.** Block elements (`<ul>`, `<ol>`, `<h3>`, `<h4>`, `<pre>`, `<table>`,
  `<hr>`) must never end up inside `<p>`. Mixed single-newline blocks (heading → subheading → list)
  are common in LLM output; split at block boundaries before wrapping paragraphs.
- **Inline formatting order.** Fenced code → inline code → emphasis (delimiter stack) →
  markdown links → bare HTTP autolinks. Emphasis runs before links so `*foo [bar](/url)*`
  resolves correctly; link labels may already contain `<em>` / `<strong>` from that pass.
  See #475 and [`docs/plans/markdown-renderer-hardening.md`](../../../docs/plans/markdown-renderer-hardening.md).
- **Soft line breaks.** Prose paragraphs preserve single newlines in HTML (CommonMark soft breaks);
  hard breaks (two+ trailing spaces) emit `<br>`. Tight list items still collapse internal
  newlines to spaces. `.message-text p` uses `white-space: pre-wrap` (the container is `normal`) so
  preserved newlines render as visible line breaks without `<br>` tags.
- **Agent-output shapes.** Support `-`, `*`, and `+` list markers. ATX `#` levels map to
  matching `<h1>`–`<h6>` tags (see `render-blocks.ts`).
- **Streaming hold.** Incomplete block starts (headings, fences) stream as plain
  text in the pending tail until their line ends. Forming GFM tables forward-pass
  into `.stream-forming` (`<table class="stream-table-forming">`) as header/separator/body
  cells arrive; committed tables append body rows via `tr.stream-pending-row` with
  inline cell updates. Pending list lines hide the `-`/`*`/`1.` marker and show
  body text with a bullet/number via `.stream-pending-list-item` until the line
  ends and the full `<ul>/<li>` (or `<ol>/<li>`) is committed; inline hold still
  suppresses half-open `**` on the current item.
- **Inline emphasis.** A single delimiter-stack path (`inline-emphasis.ts`) handles all emphasis;
  there is no separate regex fast path.
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
- **Fenced code.** Non-mermaid fences are highlighted at render time via `highlight.js` (core +
  per-language imports in `highlight.ts`). Unknown tags fall back to escaped plain text; empty
  lang uses auto-detection. Theme tokens live in `global.css` (VS Code Dark+ inspired).
- **Mermaid diagrams.** Fenced ` ```mermaid ` blocks render as SVG via lazy-loaded `mermaid`
  (`mermaid.ts`). Diagram rendering runs after final markdown insertion (`message_done`, thread
  restore) — not on every streaming token. Fenced blocks are extracted before HTML escaping; prose
  markdown (bold, lists, headings) must not run inside diagram `<pre>` tags (`mapOutsideFencedHtml`).
  Before render, `prepareMermaidSource` / `mermaidSourceCandidates` decode entities and quote brittle
  `[labels]`. We call `mermaid.run` directly (no pre-parse gate — parse rejects some diagrams that
  still render). On failure after an aggressive retry, show the inline source fallback.
- **Table layout.** Agent tables are unschema'd GFM — do not hardcode rem/% column widths for
  specific fixtures. Use shrink-to-fit edge columns (`width: 1%` + `nowrap`), `min-width: 0` on
  cells, and wrapping lone `<code>` slugs. Full rules: [`docs/ui-taste.md`](../../docs/ui-taste.md).

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

### CommonMark conformance (`commonmark-conformance.test.ts`, via `npm test`)

`renderMarkdown` is run against every example in the official CommonMark spec —
loaded from the pinned `commonmark-spec` devDependency at runtime
(`tests/commonmark/load-spec.ts`), so the ~650 examples are **not** vendored into
this repo — comparing output to the expected HTML after the spec's own normalizer
(`tests/commonmark/normalize.ts`, a faithful port of `normalize.py`). This is **at
rest only** — streaming output intentionally differs (the live tail is escaped
plain text) and is not conformance-tested.

The renderer is app-specific in places (decorated links, highlighted code), but
CommonMark is the structural reference. The set of examples we currently satisfy
is pinned in `tests/fixtures/commonmark/conformance-baseline.json`
and the test fails if it changes:

- fewer passing → a regression in a construct we used to handle.
- more passing → an improvement; re-run `UPDATE_COMMONMARK_BASELINE=1 npm test` to
  record the new baseline.

Bumping the spec is just `npm i -D commonmark-spec@<version>` followed by a
re-baseline; the version is read from the installed package and pinned in the
baseline.

### Streaming convergence fuzz (`streaming-convergence.test.ts`, via `npm test`)

Reuses the same CommonMark baseline examples (`tests/commonmark/baseline-examples.ts`)
as property-test inputs: for each passing spec example, every prefix cut (or a
strided sample when the markdown is long) feeds `StreamingMarkdownRenderer`
incrementally, then the full text, and the final display must match a fresh
complete render. When the tokenizer commits the entire input (no pending tail),
that display must also match the at-rest `renderMarkdown()` output. Set
`STREAMING_FUZZ_ALL=1` to exercise every character index on long examples.

The JS normalizer (`tests/commonmark/normalize.ts`) is differentially validated
against the reference `normalize.py` by `npm run check:normalizer-parity` (a CI
step in the `check` job; needs python3). The reference normalizer is **not**
checked in — `scripts/fetch-reference-normalizer.mts` fetches it from a pinned,
SHA-256-verified upstream commit into `tests/commonmark/normalize.py`
(gitignored) at check time. The parity check then asserts both that the
conformance pass set is identical under either normalizer and that per-example
normalized output matches byte-for-byte, except for a small documented allowlist
of pathological raw-HTML cases. This is **not** in `npm run check`, so
contributors without python can still run the default gates.

### E2e tests (seeded via `tests/e2e/helpers/seed-config.ts`)

- `tests/e2e/markdown-list-indent.e2e.ts` — Known Failures + Architecture Highlights; asserts list
  text is inset >4px from headings
- `tests/e2e/semantic-search-markdown.e2e.ts` — explore subagent timeline; asserts no raw `##` in
  rendered text, summary preview hidden when expanded, code spans intact
- `tests/e2e/mermaid-diagram.e2e.ts` — seeded flowchart; asserts `.mermaid-diagram svg` renders
- `tests/e2e/markdown-table-wrap.e2e.ts` — PR-style table; index/status stay single-line, branch
  slugs wrap, table fits pane (see `docs/ui-taste.md`)

Screenshots under `tests/e2e/screenshots/` (`markdown-list-indent-*.png`, `semantic-search-*.png`)
are updated by those specs for human review; CI asserts DOM layout, not pixels.
