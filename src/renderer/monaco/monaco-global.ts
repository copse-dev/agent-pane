import * as monaco from 'monaco-editor'

// Standalone entry for the Monaco editor library. scripts/build.mts bundles this
// into its own `monaco-bundle.js`, which monaco/setup.ts injects on demand — so
// the multi-megabyte editor stays out of the initial app.js and only loads when
// a diff or file view is actually opened. The entry's sole job is to hand the
// namespace back to the app shell.
declare global {
  interface Window {
    __copseMonaco?: typeof monaco
  }
}

window.__copseMonaco = monaco
