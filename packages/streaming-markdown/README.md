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
  GFM strikethrough → markdown links → bare HTTP autolinks. Emphasis runs before links so
  `*foo [bar](/url)*` resolves correctly; link labels may already contain `<em>` / `<strong>`
  from that pass. Strikethrough (`~~text~~` → `<del>`, `inline-strikethrough.ts`) sits between
  emphasis and links so `~~*x*~~` nests and a struck `~~[a](b)~~` still resolves its link inside
  the `<del>`; only paired **double** tildes delimit, so lone `~` (e.g. `20~25`) stays literal,
  and its streaming hold (`strikethroughHoldStart`) suppresses a half-open trailing `~~foo`.
  See #475, #613, and [`docs/plans/markdown-renderer-hardening.md`](../../docs/plans/markdown-renderer-hardening.md).
- **Soft line breaks.** Prose paragraphs preserve single newlines in HTML (CommonMark soft breaks);
  hard breaks (two+ trailing spaces, or a backslash before the newline) emit `<br>` and swallow the
  next line's leading indentation. Breaks are marked before inline rendering (`markHardBreaks` in
  `render-prose-inline.ts`) so emphasis spans keep them; code-span interiors and raw `<tag>` spans
  are exempt. Tight list items still collapse internal newlines to spaces. `.message-text p` uses
  `white-space: pre-wrap` (the container is `normal`) so preserved newlines render as visible line
  breaks without `<br>` tags.
- **Agent-output shapes.** Support `-`, `*`, and `+` list markers. ATX `#` levels map to
  matching `<h1>`–`<h6>` tags; setext underlines (`===`/`---`) map to `<h1>`/`<h2>`
  (see `render-blocks.ts`).
- **Benign raw inline HTML.** Attribute-less phrasing tags models emit in prose
  (`<b> <i> <u> <s> <del> <ins> <sub> <sup> <kbd> <mark> <br>`) pass through unescaped
  (`BENIGN_RAW_INLINE_TAG_RE` in `escape.ts`); the DOMPurify sink allowlist mirrors the set.
  Anything with attributes, and all block/structural raw HTML, stays escaped — see the
  raw-HTML policy discussion in #600 before widening this.
- **Streaming hold.** Incomplete block starts (fences, thematic breaks, blockquotes) stream as
  plain text in the inline pending tail until their line ends. Open fenced code blocks
  forward-pass into `.stream-forming` as `<pre class="stream-fence-forming">` with highlight.js on
  the body so far (mermaid fences show a pending source placeholder until complete).
  Forming GFM tables forward-pass into `.stream-forming` (`<table class="stream-table-forming">`) as header/separator/body
  cells arrive; committed tables append body rows via `tr.stream-pending-row` with
  inline cell updates. Pending **list** lines hide the `-`/`*`/`1.` marker and show
  body text with a bullet/number via `.stream-pending-list-item` until the line
  ends and the full `<ul>/<li>` (or `<ol>/<li>`) is committed. Pending **ATX
  headings** (`#` … `######`) hide the hash run and render title text in a
  `<div class="stream-pending-heading stream-pending-hN">` (`data-heading-level`) with
  matching heading weight/size until the line completes. **HTML entities** in prose
  (`&nbsp;`, `&#160;`) decode via `decodeSafeMarkdownEntities()` (with incomplete suffixes
  held so `&nbsp` never flashes literally); other entities stay escaped for XSS safety.
  Inline hold still suppresses half-open `**` on the current line.

  Pending shapes (`streaming-pending-matrix.test.ts`):

  | While streaming         | DOM / class                                                      | Raw marker hidden?      | Inline MD in tail? |
  | ----------------------- | ---------------------------------------------------------------- | ----------------------- | ------------------ |
  | Prose paragraph         | `<p class="stream-pending-paragraph">`                           | n/a                     | yes                |
  | `- item` / `1. item`    | `<ul>/<ol>` with native `<li class="stream-pending-list-item">`  | yes                     | yes                |
  | Nested `  - item`       | nested `<ul>/<ol>` inside open `<li>`                            | yes                     | yes                |
  | Lazy list continuation  | `<span class="stream-pending-list-continuation">` in open `<li>` | n/a (plain text)        | yes                |
  | `### Heading`           | `<div class="stream-pending-heading stream-pending-hN">`         | yes                     | yes                |
  | `> quote`               | `<blockquote class="stream-pending-blockquote"><p>…</p>`         | yes                     | yes                |
  | `---`                   | `<span class="stream-pending">` escaped plain text               | no                      | no                 |
  | Forming `\| H \|` table | `.stream-forming` + `<th>`                                       | pipes = cell boundaries | per cell           |
  | Pending table body row  | `tr.stream-pending-row` + `<td>`                                 | pipes = cell boundaries | per cell           |
  | Open fenced code        | `.stream-forming pre.stream-fence-forming`                       | yes                     | highlighted        |

### Streaming architecture (intentional duplication)

The streaming layer maintains **two parallel emitters** for the same decisions:

| Path            | Used by                     | Updates                   |
| --------------- | --------------------------- | ------------------------- |
| String HTML     | `renderStreamingMarkdown`   | full re-render each token |
| Incremental DOM | `StreamingMarkdownRenderer` | forward-pass patches      |

Shared helpers (`renderStreamingTableCell`, `insertBeforeTrailingListClose`,
`splitOpenBlockAtLastNewline`, `clearBlockPendingDom`, `blockPendingClassName`, …) hold
**decision logic** in one place. Emitters stay separate on purpose — merging HTML builders
with DOM sync (e.g. always setting `innerHTML` from a string) breaks incremental updates and
is brittle under `streaming-convergence.test.ts`.

**Not yet unified** (higher risk; defer unless adding a new pending shape):

- Forming-table line parser shared by `buildFormingTableHtml` / `syncFormingTableDom` (separator
  row HTML vs DOM intentionally differ).
- List pending: `appendListPendingHtml` vs `syncListPendingDom`.
- Block pending metadata: `blockPendingAttrs` (HTML) vs `setAttribute` in DOM sync.
- `classifyPendingBlock()` — single classifier for `isBlockLevelPending` / `blockPendingTag` /
  `blockPendingClassName`.
- Orchestration object shared by `renderStreamingMarkdown` and `StreamingMarkdownRenderer.update`.
- `render-pending-line.ts` hold→visible→render branches (readability only).

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
  lang uses auto-detection. Theme tokens live in `global.css` (VS Code Dark+ inspired). Content is
  kept **verbatim** — interior/leading/trailing blank lines and the first line's indentation
  survive (`highlightFenceCode` no longer trims; blank-only fences are preserved), and only the
  opening fence's own indentation is stripped from content lines (`parseFenceSlice`). The language
  is the first word of the info string with backslash escapes / entities decoded
  (`fenceInfoLanguage`, spec #24: ` `foo\+bar ```→`language-foo+bar`) (#598).
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

#### Raw-HTML policy and the in-scope conformance ceiling (#600)

**100% CommonMark is deliberately not the goal.** The renderer escapes untrusted
HTML rather than passing it through — the sanitize-at-the-sink invariant above.
Two spec sections are therefore expected to fail by design:

| Section     | Baseline | Why it caps out                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------------ |
| HTML blocks | 2/44     | Full conformance needs `<script>`/`<style>`/`<div>`/arbitrary custom tags verbatim.  |
| Raw HTML    | 8/20     | Same — no inline allowlist ever reaches 20/20 without passing attacker HTML through. |

The only raw HTML that passes through is the **benign attribute-less inline
allowlist** (`b i u s del ins sub sup kbd mark br`, `BENIGN_RAW_INLINE_TAG_RE` in
`escape.ts`), mirrored by the DOMPurify sink. Everything with attributes, and all
block/structural raw HTML, stays escaped.

So the realistic ceiling excludes those **64 HTML examples**: **588 in-scope
examples**, of which the renderer currently satisfies **~492 (~84%)**. Counting all
652 examples the baseline is **502 (~77%)**. Both numbers move as non-HTML
conformance grows — `summaryBySection` in the baseline JSON carries the live
per-section counts; treat the two headline figures here as approximate.

**Passthrough is a future library option, not an app mode.** A `rawHtml:
'escape' | 'passthrough'` switch (see #600) would let the conformance harness
measure the true spec ceiling while the app keeps `escape` + sink sanitization;
`escape` stays the default because passthrough drops from two defense layers to
one. This belongs to the extracted package's public API (#601) and is not
implemented yet. HTML **block recognition** in `block-tokenizer.ts` can still land
with emission escaped, and `<details>`/`<summary>` stay excluded until it does
(they pair across blocks and would emit unbalanced tags mid-stream).

### Streaming convergence fuzz (`streaming-convergence.test.ts`, via `npm test`)

Reuses the same CommonMark baseline examples (`tests/commonmark/baseline-examples.ts`)
as property-test inputs: for each passing spec example, every prefix cut (or a
strided sample when the markdown is long) feeds `StreamingMarkdownRenderer`
incrementally, then the full text, and the final display must match a fresh
complete render. When the tokenizer commits the entire input (no pending tail),
that display must also match the at-rest `renderMarkdown()` output. Set
`STREAMING_FUZZ_ALL=1` to exercise every character index on long examples.

### Terms of Service fixture (`streaming-terms-of-service.test.ts`)

Real-world agent output in `tests/fixtures/terms-of-service-streaming.md` — nbsp metadata,
numbered clauses, subscription fee table, blockquotes, and a fenced address block. Tests
scan incremental streaming cuts for partial-table artifacts (raw `| cell |` text in inline
`.stream-pending` or prose blocks while a table is already committed). Use this fixture when
changing table/list/metadata streaming behaviour.

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
- `tests/e2e/markdown-streaming-list.e2e.ts` — lazy list continuations stream inside the open
  `<li>` without a fake bullet row
- `tests/e2e/markdown-streaming-heading.e2e.ts` — pending `###` titles render in
  `.stream-pending-heading` without raw `#` markers
- `tests/e2e/markdown-streaming-blockquote.e2e.ts` — pending `>` lines render in
  `<blockquote class="stream-pending-blockquote">` without raw `>` markers
- `tests/e2e/markdown-nbsp-metadata.e2e.ts` — sprint/RFC metadata lines decode `&nbsp;` while
  streaming
- `tests/e2e/semantic-search-markdown.e2e.ts` — explore subagent timeline; asserts no raw `##` in
  rendered text, summary preview hidden when expanded, code spans intact
- `tests/e2e/mermaid-diagram.e2e.ts` — seeded flowchart; asserts `.mermaid-diagram svg` renders
- `tests/e2e/markdown-table-wrap.e2e.ts` — PR-style table; index/status stay single-line, branch
  slugs wrap, table fits pane (see `docs/ui-taste.md`)

Screenshots under `tests/e2e/screenshots/` (`markdown-list-indent-*.png`, `semantic-search-*.png`)
are updated by those specs for human review; CI asserts DOM layout, not pixels.
