import { setSanitizerBackend } from '@copse/streaming-markdown'

let ready: Promise<void> | null = null

/**
 * Ensure @copse/streaming-markdown has a working sanitizer backend before any
 * markdown sink renders.
 *
 * The package defaults to the browser-native Sanitizer API, but `Element.setHTML`
 * runs Chromium's default sanitizer first and strips the `class` attribute — which
 * carries highlight.js (`hljs-*`) and mermaid hooks — before the package's
 * allowlist walk can keep it, so syntax highlighting is lost under the native
 * backend. Use DOMPurify (which honours the package's `class` allowlist) instead,
 * loaded via a deferred dynamic import so it stays off the eager startup path
 * rather than being bundled at module load. Idempotent; awaiting the returned
 * promise guarantees the backend is in place.
 */
export function installSanitizerBackend(): Promise<void> {
  ready ??= import('@copse/streaming-markdown/sanitizers/dompurify').then(
    ({ dompurifyBackend }) => {
      setSanitizerBackend(dompurifyBackend)
    },
  )
  return ready
}
