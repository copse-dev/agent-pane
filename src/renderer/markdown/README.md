# Markdown app glue

The parser/renderer core lives in the standalone
[`@copse/streaming-markdown`](https://github.com/copse-dev/streaming-markdown)
package (consumed as a dependency) — see its README/`docs/ARCHITECTURE.md` for the
design invariants, streaming architecture, and the CommonMark conformance +
convergence-fuzz harness. Core behaviour is injected, not imported: the app
provides a `LinkDecorator`, a `RawImageRenderer`, and a `SanitizeExtension` (see
`artifact-image-policy.ts`). Anything app-specific belongs here.

This directory keeps the app-side integration only:

- `file-links.ts`, `workspace-links.ts`, `browser-links.ts` — click handlers and
  decoration for links the renderer emits (`data-workspace-link`,
  `data-browser-link`).
- `remote-artifact-images.ts` — post-sanitization hydration of
  `remote-artifact-image` placeholders (see the sink allowlist notes in the
  package's `sanitize.ts`).
- `code-block-copy.ts` — copy buttons on rendered fenced blocks.
- `mermaid.ts`, `mermaid-expand.ts`, `mermaid-fallback.ts` — lazy mermaid
  rendering after final insertion, expand/collapse, and the inline source
  fallback.

E2e specs for markdown rendering stay in `tests/e2e/*.e2e.ts` (see the package
README's regression section for the list).
