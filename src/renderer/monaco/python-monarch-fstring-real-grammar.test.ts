import { describe, it, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import type * as Monaco from 'monaco-editor'
import { withMultilineFStringFix } from './python-monarch-fstring-fix.ts'

// This file pins withMultilineFStringFix against the REAL monaco-editor python
// grammar, imported through the exact specifier monaco-global.ts uses. The
// sibling test file exercises the transform against a hand-copied replica of
// the 0.56 grammar; only this test fails when a monaco-editor upgrade reshapes
// the shipped rules and would otherwise silently revert the f-string fix.
//
// The definition module imports monaco's editor.api.js, whose module scope
// expects a browser. jsdom (already a repo dependency, external in the test
// bundle) provides enough of one; the definition itself is inert data. Globals
// are installed before a dynamic import so nothing browser-flavored executes
// early, and `node --test` runs each test file in its own process, so the
// globals leak nowhere.
function installBrowserGlobals(): JSDOM {
  const dom = new JSDOM('', { pretendToBeVisual: true })
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (key in globalThis) continue
    try {
      Reflect.set(globalThis, key, Reflect.get(dom.window, key))
    } catch {
      // Read-only or throwing accessor — monaco's import path never needs it.
    }
  }
  // monaco's platform sniffing calls these on globalThis itself, and jsdom
  // defines them on prototypes (not own properties), so the copy above misses
  // them. Bind explicitly.
  for (const name of [
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
    'postMessage',
    'matchMedia',
    'getComputedStyle',
  ]) {
    const value: unknown = Reflect.get(dom.window, name)
    if (typeof value === 'function') {
      Reflect.set(globalThis, name, value.bind(dom.window))
    }
  }
  Reflect.set(globalThis, 'window', dom.window)
  Reflect.set(globalThis, 'self', dom.window)
  return dom
}

describe('withMultilineFStringFix against the shipped monaco grammar', () => {
  let language: Monaco.languages.IMonarchLanguage

  before(async () => {
    installBrowserGlobals()
    const definition = await import('monaco-editor/languages/definitions/python/python.js')
    language = definition.language
  })

  it('transforms the real grammar without bailing', () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      const patched = withMultilineFStringFix(language)
      assert.notEqual(
        patched,
        language,
        'the patch bailed on the shipped grammar — a monaco-editor upgrade reshaped the ' +
          'Monarch python rules; update python-monarch-fstring-fix.ts to match',
      )
      assert.equal(warn.mock.callCount(), 0)
      assert.notEqual(patched.tokenizer['strings'], language.tokenizer['strings'])
      assert.ok(Array.isArray(patched.tokenizer['fEndDocString']))
      assert.ok(Array.isArray(patched.tokenizer['fEndDblDocString']))
    } finally {
      warn.mock.restore()
    }
  })

  it('routes the shipped strings state into the new multi-line f-string states', () => {
    const patched = withMultilineFStringFix(language)
    const strings = patched.tokenizer['strings']
    assert.ok(Array.isArray(strings))
    const nexts = strings.map((rule) => (Array.isArray(rule) ? rule[2] : undefined))
    assert.ok(nexts.includes('@fEndDocString'), 'strings routes to @fEndDocString')
    assert.ok(nexts.includes('@fEndDblDocString'), 'strings routes to @fEndDblDocString')
  })

  it('still finds every state the injected rules hand off to', () => {
    // The patched rules and states reference these; setMonarchTokensProvider
    // compiles synchronously and throws if any is missing (monaco-global.ts).
    for (const state of ['fStringBody', 'fDblStringBody', 'fStringDetail']) {
      assert.ok(Array.isArray(language.tokenizer[state]), state)
    }
  })
})
