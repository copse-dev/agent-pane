import { describe, it, mock } from 'node:test'
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
      ["[fF][rR]?'''", 'string.escape', '@fEndDocString'],
      ["[rR][fF]'''", 'string.escape', '@fEndDocString'],
      ["[fF][rR]?'", 'string.escape', '@fStringBody'],
      ["[rR][fF]'", 'string.escape', '@fStringBody'],
      ["'", 'string.escape', '@stringBody'],
      ['"$', 'string.escape', '@popall'],
      ['[fF][rR]?"""', 'string.escape', '@fEndDblDocString'],
      ['[rR][fF]"""', 'string.escape', '@fEndDblDocString'],
      ['[fF][rR]?"', 'string.escape', '@fDblStringBody'],
      ['[rR][fF]"', 'string.escape', '@fDblStringBody'],
      ['"', 'string.escape', '@dblStringBody'],
    ])
  })

  it('covers every f-string prefix spelling, but never a lone raw prefix', () => {
    const patched = withMultilineFStringFix(upstreamPythonGrammar())
    const tripleRules = shortRules(patched, 'strings').filter(
      ([, , next]) => next === '@fEndDocString' || next === '@fEndDblDocString',
    )
    const matchesTriple = (opener: string): boolean =>
      tripleRules.some(([source]) => new RegExp(`^(?:${source})`).test(opener))
    for (const prefix of ['f', 'F', 'rf', 'fr', 'rF', 'Rf', 'fR', 'FR']) {
      assert.ok(matchesTriple(`${prefix}'''`), `${prefix}''' routes to a multi-line state`)
      assert.ok(matchesTriple(`${prefix}"""`), `${prefix}""" routes to a multi-line state`)
    }
    // A plain raw/byte string has no interpolations; it must keep falling
    // through to the grammar's identifier + docstring path.
    for (const opener of ["r'''", 'R"""', "b'''", "ff'''"]) {
      assert.ok(!matchesTriple(opener), `${opener} stays on the docstring path`)
    }
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

  it('does not warn when the patch applies cleanly', () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      withMultilineFStringFix(upstreamPythonGrammar())
      assert.equal(warn.mock.callCount(), 0)
    } finally {
      warn.mock.restore()
    }
  })

  it('leaves an already-fixed grammar untouched, warning', () => {
    const patched = withMultilineFStringFix(upstreamPythonGrammar())
    assertBailsLoudly(patched)
  })

  it('leaves an unrecognized grammar untouched when the f-string rules moved, warning', () => {
    const changed = upstreamPythonGrammar()
    changed.tokenizer['strings'] = [[/f?'{1,3}/, 'string.escape', '@fStringBody']]
    assertBailsLoudly(changed)
  })

  it('leaves an unrecognized grammar untouched when strings is not a rule list, warning', () => {
    const changed = upstreamPythonGrammar()
    delete changed.tokenizer['strings']
    assertBailsLoudly(changed)
  })

  it('leaves an unrecognized grammar untouched when a referenced state is missing, warning', () => {
    // The injected rules hand off to these states; registering a grammar that
    // references a missing state would make Monarch's synchronous compile
    // throw (see monaco-global.ts), so the patch must step aside instead.
    for (const state of ['fStringBody', 'fDblStringBody', 'fStringDetail']) {
      const changed = upstreamPythonGrammar()
      changed.tokenizer = Object.fromEntries(
        Object.entries(changed.tokenizer).filter(([name]) => name !== state),
      )
      assertBailsLoudly(changed)
    }
  })
})

/** The grammar comes back untouched and exactly one warning names the fix. */
function assertBailsLoudly(language: Monaco.languages.IMonarchLanguage): void {
  const warn = mock.method(console, 'warn', () => {})
  try {
    assert.equal(withMultilineFStringFix(language), language)
    assert.equal(warn.mock.callCount(), 1)
    const call = warn.mock.calls[0]
    assert.ok(call)
    const [message] = call.arguments
    assert.ok(typeof message === 'string')
    assert.match(message, /python-monarch-fstring-fix/)
    assert.match(message, /did not apply/)
  } finally {
    warn.mock.restore()
  }
}
