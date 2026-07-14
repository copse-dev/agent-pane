import { isBrowserSanitizerSupported, setDefaultConfig } from '@copse/streaming-markdown'

let ready: Promise<void> | null = null

/**
 * Ensure @copse/streaming-markdown has a working sanitizer backend before any
 * markdown sink renders.
 *
 * Prefer the zero-dependency native Sanitizer API (`Element.setHTML`), which the
 * Electron renderer's Chromium provides. The package now hands its allowlist to
 * `setHTML` so the native backend preserves the `class` attribute — the
 * highlight.js (`hljs-*`) and mermaid hooks it used to strip (streaming-markdown
 * #45) — so it renders identically to DOMPurify without bundling it. Only where
 * the native API is absent (older engines, non-browser contexts) do we lazily
 * import the DOMPurify backend, keeping it off the eager startup path. Idempotent;
 * awaiting the returned promise guarantees the backend is in place.
 */
export function installSanitizerBackend(): Promise<void> {
  ready ??= isBrowserSanitizerSupported()
    ? Promise.resolve()
    : import('@copse/streaming-markdown/sanitizers/dompurify').then(({ dompurifyBackend }) => {
        setDefaultConfig({ sanitizerBackend: dompurifyBackend })
      })
  return ready
}
