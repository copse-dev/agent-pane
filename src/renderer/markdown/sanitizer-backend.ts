import { setSanitizerBackend } from '@copse/streaming-markdown'
import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'

// @copse/streaming-markdown ≥0.2 sanitizes through a pluggable backend and, when
// none is set, defaults to the browser-native Sanitizer API — throwing where it
// is absent. Pin the bundled DOMPurify backend so sanitization is available
// regardless of the runtime's Sanitizer-API support and matches the sanitizer
// agent-pane used before the renderer package went pluggable. Call once at
// startup, before the first markdown sink renders.
let installed = false

export function installSanitizerBackend(): void {
  if (installed) return
  installed = true
  setSanitizerBackend(dompurifyBackend)
}
