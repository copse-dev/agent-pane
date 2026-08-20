import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import { withMultilineFStringFix } from './python-monarch-fstring-fix.ts'

// The f-string-related slice of monaco-editor 0.56's Monarch Python grammar,
// verbatim. If a monaco upgrade changes these rules the patch must step aside;
// the "leaves an unrecognized grammar untouched" cases below pin that.
function upstreamPythonGrammar(): Monaco.languages.IMonarchLanguage {
  return {
    defaultToken: '',
    tokenPostfix: '.python',
    tokenizer: {
      root: [{ include: '@whitespace' }, { include: '@strings' }],
      whitespace: [
        [/\s+/, 'white'],
        [/'''/, 'string', '@endDocString'],
        [/"""/, 'string', '@endDblDocString'],
      ],
      endDocString: [
        [/[^']+/, 'string'],
        [/\\'/, 'string'],
        [/'''/, 'string', '@popall'],
        [/'/, 'string'],
      ],
      endDblDocString: [
        [/[^"]+/, 'string'],
        [/\\"/, 'string'],
        [/"""/, 'string', '@popall'],
        [/"/, 'string'],
      ],
      strings: [
        [/'$/, 'string.escape', '@popall'],
        [/f'{1,3}/, 'string.escape', '@fStringBody'],
        [/'/, 'string.escape', '@stringBody'],
        [/"$/, 'string.escape', '@popall'],
        [/f"{1,3}/, 'string.escape', '@fDblStringBody'],
        [/"/, 'string.escape', '@dblStringBody'],
      ],
      fStringBody: [
        [/[^\\'{}]+$/, 'string', '@popall'],
        [/[^\\'{}]+/, 'string'],
        [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
        [/\\./, 'string'],
        [/'/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      stringBody: [
        [/[^\\']+$/, 'string', '@popall'],
        [/[^\\']+/, 'string'],
        [/\\./, 'string'],
        [/'/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      fDblStringBody: [
        [/[^\\"{}]+$/, 'string', '@popall'],
        [/[^\\"{}]+/, 'string'],
        [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
        [/\\./, 'string'],
        [/"/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      dblStringBody: [
        [/[^\\"]+$/, 'string', '@popall'],
        [/[^\\"]+/, 'string'],
        [/\\./, 'string'],
        [/"/, 'string.escape', '@popall'],
        [/\\$/, 'string'],
      ],
      fStringDetail: [
        [/[:][^}]+/, 'string'],
        [/[!][ars]/, 'string'],
        [/=/, 'string'],
        [/\}/, 'identifier', '@pop'],
      ],
    },
  }
}

function shortRules(
  language: Monaco.languages.IMonarchLanguage,
  state: string,
): [string, string, string?][] {
  const rules = language.tokenizer[state]
  assert.ok(Array.isArray(rules), `expected tokenizer state ${state}`)
  return rules.map((rule) => {
    assert.ok(Array.isArray(rule), `expected only short-form rules in ${state}`)
    const [regex, action, next] = rule
    assert.ok(regex instanceof RegExp)
    assert.ok(typeof action === 'string')
    return next === undefined ? [regex.source, action] : [regex.source, action, next]
  })
}

describe('withMultilineFStringFix', () => {
  it('routes triple-quoted f-strings to multi-line states, ahead of the single-line ones', () => {
    const patched = withMultilineFStringFix(upstreamPythonGrammar())
    assert.deepEqual(shortRules(patched, 'strings'), [
      ["'$", 'string.escape', '@popall'],
      ["f'''", 'string.escape', '@fEndDocString'],
      ["f'", 'string.escape', '@fStringBody'],
      ["'", 'string.escape', '@stringBody'],
      ['"$', 'string.escape', '@popall'],
      ['f"""', 'string.escape', '@fEndDblDocString'],
      ['f"', 'string.escape', '@fDblStringBody'],
      ['"', 'string.escape', '@dblStringBody'],
    ])
  })

  it('closes the new states only on the matching triple quote, popping the whole stack', () => {
    const patched = withMultilineFStringFix(upstreamPythonGrammar())
    for (const [state, quote] of [
      ['fEndDocString', "'"],
      ['fEndDblDocString', '"'],
    ] as const) {
      const rules = shortRules(patched, state)
      const close = rules.find(([, , next]) => next === '@popall')
      assert.deepEqual(close, [quote.repeat(3), 'string', '@popall'], state)
      // A lone quote inside the string body must stay string-coloured, not close it.
      assert.ok(
        rules.some(
          ([source, action, next]) => source === quote && action === 'string' && next === undefined,
        ),
        `${state} keeps a lone ${quote} inside the string`,
      )
      // Interpolations still highlight: `{expr` hands off to the shared detail state.
      assert.ok(
        rules.some(([, , next]) => next === '@fStringDetail'),
        `${state} opens @fStringDetail for interpolations`,
      )
    }
  })

  it('shares every untouched tokenizer state with the input grammar', () => {
    const original = upstreamPythonGrammar()
    const patched = withMultilineFStringFix(original)
    assert.notEqual(patched, original)
    for (const state of Object.keys(original.tokenizer)) {
      if (state === 'strings') continue
      assert.equal(patched.tokenizer[state], original.tokenizer[state], state)
    }
  })

  it('leaves an already-fixed grammar untouched', () => {
    const patched = withMultilineFStringFix(upstreamPythonGrammar())
    assert.equal(withMultilineFStringFix(patched), patched)
  })

  it('leaves an unrecognized grammar untouched when the f-string rules moved', () => {
    const changed = upstreamPythonGrammar()
    changed.tokenizer['strings'] = [[/f?'{1,3}/, 'string.escape', '@fStringBody']]
    assert.equal(withMultilineFStringFix(changed), changed)
  })

  it('leaves an unrecognized grammar untouched when strings is not a rule list', () => {
    const changed = upstreamPythonGrammar()
    delete changed.tokenizer['strings']
    assert.equal(withMultilineFStringFix(changed), changed)
  })
})
