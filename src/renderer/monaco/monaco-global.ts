import * as monaco from 'monaco-editor'
import { language as pythonLanguage } from 'monaco-editor/languages/definitions/python/python.js'
import { withMultilineFStringFix } from './python-monarch-fstring-fix.ts'

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

// Registered here, in the bundle that already carries the python definition, so
// the app bundle never imports monaco's ESM tree a second time. An explicitly
// set tokens provider takes precedence over the lazy per-language factory the
// monaco-editor package registers on import.
monaco.languages.setMonarchTokensProvider('python', withMultilineFStringFix(pythonLanguage))

window.__copseMonaco = monaco
