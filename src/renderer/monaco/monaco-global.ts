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
//
// setMonarchTokensProvider with a plain grammar object compiles it
// synchronously, and the Monarch compiler throws on an inconsistent grammar
// (e.g. a rule referencing a missing state). A throw here would leave
// `window.__copseMonaco` unset and kill every Monaco surface in the app, so a
// bad patched grammar must degrade to upstream python highlighting instead.
try {
  monaco.languages.setMonarchTokensProvider('python', withMultilineFStringFix(pythonLanguage))
} catch (error) {
  console.error(
    '[monaco-global] registering the patched python grammar failed; falling back to the ' +
      'unpatched upstream grammar (multi-line f-strings will corrupt highlighting, #1752)',
    error,
  )
  try {
    monaco.languages.setMonarchTokensProvider('python', pythonLanguage)
  } catch (fallbackError) {
    console.error('[monaco-global] registering the upstream python grammar failed', fallbackError)
  }
}

window.__copseMonaco = monaco
