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
- `mermaid.ts`, `mermaid-frame.ts`, `mermaid-expand.ts`, `mermaid-fallback.ts` —
  isolated diagram frames after final insertion, expansion in a fresh frame,
  and the inert source fallback. `mermaid-frame-entry.ts` and `mermaid-render.ts`
  are bundled separately and execute only inside `mermaid-frame.html`.
  See [the isolation prototype](../../../docs/spikes/mermaid-isolation.md) for
  the protocol, security boundaries, and remaining production work.

E2e specs for markdown rendering stay in `tests/e2e/*.e2e.ts` (see the package
README's regression section for the list).
