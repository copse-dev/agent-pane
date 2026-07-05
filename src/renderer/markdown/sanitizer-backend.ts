import { isBrowserSanitizerSupported, setSanitizerBackend } from '@copse/streaming-markdown'

let ready: Promise<void> | null = null

/**
 * Ensure @copse/streaming-markdown has a working sanitizer backend before any
 * markdown sink renders.
 *
 * The package sanitizes through a pluggable backend and defaults to the
 * zero-dependency native Sanitizer API (`Element.setHTML`), which the Electron
 * renderer's Chromium provides — so on the normal path nothing is loaded. Only
 * where the native API is missing (older engines, some non-browser contexts) do
 * we import the DOMPurify backend, deferring it to a dynamic import so it stays
 * off the startup path rather than being an eager dependency. Idempotent;
 * awaiting the returned promise guarantees the backend is in place.
 */
export function installSanitizerBackend(): Promise<void> {
  ready ??= isBrowserSanitizerSupported()
    ? Promise.resolve()
    : import('@copse/streaming-markdown/sanitizers/dompurify').then(({ dompurifyBackend }) => {
        setSanitizerBackend(dompurifyBackend)
      })
  return ready
}
