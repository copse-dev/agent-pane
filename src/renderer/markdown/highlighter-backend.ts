let ready: Promise<void> | null = null

/**
 * Register a syntax-highlighter with @copse/streaming-markdown before any
 * markdown sink renders.
 *
 * The package made highlighting a pluggable backend (streaming-markdown #37): the
 * core renders fenced code as escaped plain text — `<code class="hljs lang-*">`
 * with no token spans — until a {@link CodeHighlighter} is registered. We lazily
 * import the highlight.js backend so its grammar payload is a code-split chunk
 * kept off the eager startup path (like `mermaid`), then register it. boot()
 * awaits the returned promise so the backend is in place before the first render
 * and code blocks get their `hljs-*` token spans. Idempotent.
 */
export function installHighlighterBackend(): Promise<void> {
  ready ??= import('@copse/streaming-markdown/highlighters/highlightjs').then(
    ({ loadHighlightjs }) => loadHighlightjs().then(() => undefined),
  )
  return ready
}
