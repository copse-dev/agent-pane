import {
  disableBrotliDecoding,
  nodeHasBrotliDecoderFix,
} from './services/security/brotli-decode-guard.ts'

// Imported first by every Copse process that may decode untrusted HTTP
// responses, so no module captures zlib's Brotli decoder or `fetch` before the
// guard swaps them. Electron's bundled Node decides; once Copse ships an
// Electron whose Node carries the CVE-2026-111497 fix, this does nothing.
if (!nodeHasBrotliDecoderFix(process.versions.node)) disableBrotliDecoding()
