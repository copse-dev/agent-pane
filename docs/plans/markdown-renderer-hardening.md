# Markdown renderer: streaming-parser alternatives & XSS hardening

The custom regex markdown renderer (`src/renderer/markdown/renderer.ts`) is the
largest residual XSS surface. It escapes prose first and validates link hrefs, so
it is careful, but hand-rolled HTML assembly by string concatenation is inherently
fragile. This note records the exploration of alternatives and the decision taken.

## Question

Are there well-maintained, robust **streaming** markdown parsers we should adopt
instead of the hand-rolled renderer? If not, how do we harden our own?

## What we render today

Vanilla TS, esbuild, Electron renderer. `renderMarkdown()` is a pure string→HTML
function; output is assigned to `innerHTML` at three sinks (`streaming.ts`,
`conversation.ts`, `context-panel.ts`). On top of CommonMark-ish prose it supports
features tied to this app: GFM tables, `highlight.js` code blocks, lazy `mermaid`
diagrams, in-app browser links (`data-browser-link`), and an incremental streaming
renderer that re-renders only completed lines and keeps the live tail as
`textContent`.

## Alternatives surveyed

| Option                                 | Maintenance                                                                                 | XSS posture                                                                                                         | Streaming                                                                            | Fit                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **marked + DOMPurify**                 | marked very active, huge install base; DOMPurify (cure53) is the de-facto, fuzzed sanitizer | Strong — DOMPurify is the gold standard                                                                             | Not streaming-native; re-parse the completed buffer per newline (what we already do) | Good, but loses our mermaid/hljs/link wiring unless reimplemented as extensions                             |
| **markdown-it + DOMPurify**            | Very active, large plugin ecosystem; `html:false` by default                                | Strong with DOMPurify; note recent parser CVEs (e.g. CVE-2025-7969) — sanitizer is still required                   | Same as marked                                                                       | Good; heavier than we need                                                                                  |
| **streaming-markdown (`smd`)**         | Niche (~few hundred stars), self-described "experimental"; last release 2025                | README makes **no** sanitization guarantees; DOM-based so text is safe, but raw-HTML/attribute handling is unvetted | Streaming-native (DOM, optimistic)                                                   | Risky — would still need DOMPurify, and it is far less battle-tested than our renderer + a vetted sanitizer |
| **remark/micromark + rehype-sanitize** | Very active, spec-correct                                                                   | Strong                                                                                                              | Not streaming-native                                                                 | Heaviest; large dependency tree for our small feature set                                                   |

### Takeaways

- There is **no** streaming-native parser that is simultaneously more
  battle-tested than our renderer _and_ safe out of the box. The purpose-built
  streaming libraries (e.g. `smd`) are smaller and make no XSS guarantees, so they
  would still need a sanitizer bolted on.
- Every robust recommendation in the ecosystem converges on the same backstop:
  **render with whatever parser, then sanitize the HTML with DOMPurify** before it
  touches the DOM. LLM output should be treated as untrusted user input.
- A full migration to marked/markdown-it would mean re-implementing our mermaid,
  highlight.js, streaming, and in-app-link behaviour as plugins — a large change
  for no security gain over "our renderer + DOMPurify".

## Decision

Keep the renderer (it handles our streaming + mermaid + hljs + link needs well)
and add **DOMPurify as a defense-in-depth sanitization layer** at every
`innerHTML` sink. This directly neutralizes the "hand-rolled HTML assembly is
fragile" risk: regardless of what the regex assembly produces — or what a future
edit breaks — DOMPurify strips anything outside the small, known allowlist of tags
and attributes the renderer is supposed to emit before it reaches the DOM.

### Implementation

- `src/renderer/markdown/sanitize.ts` — `sanitizeRenderedMarkdown(html)` wraps
  DOMPurify with a narrow allowlist mirroring the renderer's output (prose, GFM
  tables, highlighted code, mermaid scaffolding; `href`/`target`/`rel`/`class`/
  `data-browser-link`).
- Applied at all three sinks: `streaming.ts`, `conversation.ts`,
  `context-panel.ts`. `renderMarkdown()` itself stays a pure string function (so
  its unit tests still run without a DOM); sanitization happens at the DOM
  boundary.
- Mermaid SVG is generated _after_ sanitization by the mermaid library, so it
  never passes through the sanitizer.

### Testing note

DOMPurify needs a spec-complete DOM. The shared happy-dom test setup mis-parses
sanitized output, so tests that exercise the sanitizer use a jsdom setup
(`tests/setup-dom-jsdom.ts`). Node's test runner isolates each file in its own
process, so this does not affect the happy-dom globals used elsewhere.

## Follow-ups (not in this change)

- A dedicated fuzzing pass over `renderMarkdown()` to find structural-correctness
  bugs (the sanitizer covers _safety_, not correctness).
- Revisit a full parser migration only if requirements clearly outgrow the
  hand-rolled renderer (per `src/renderer/markdown/README.md`).
