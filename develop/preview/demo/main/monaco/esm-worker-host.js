// Host script for Monaco ESM language/editor workers in Electron (file://).
// Loaded with ?entry=vs/language/css/css.worker.js (path relative to this file's dir).
// Sets Monaco's module root, imports the real worker, then signals readiness to the app.
const hostUrl = new URL(import.meta.url)
const entryRel = hostUrl.searchParams.get('entry')
if (!entryRel) {
  throw new Error('copse monaco worker host: missing entry query param')
}
globalThis._VSCODE_FILE_ROOT = new URL('./', hostUrl).href
await import(new URL(entryRel, hostUrl).href)
globalThis.postMessage({ type: 'copse-monaco-worker-ready' })
