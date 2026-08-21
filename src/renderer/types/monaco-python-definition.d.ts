// monaco-editor ships no types for its per-language definition modules, but its
// package exports allow deep imports of them ("./*.js" → "./esm/vs/*.js"). The
// python definition is imported by monaco/monaco-global.ts so its Monarch
// grammar can be patched — see monaco/python-monarch-fstring-fix.ts.
declare module 'monaco-editor/languages/definitions/python/python.js' {
  import type * as Monaco from 'monaco-editor'

  export const conf: Monaco.languages.LanguageConfiguration
  export const language: Monaco.languages.IMonarchLanguage
}
