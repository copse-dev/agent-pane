import type * as Monaco from 'monaco-editor'

type MonarchRule = Monaco.languages.IMonarchLanguageRule

/**
 * Fix Monaco's Monarch Python grammar for triple-quoted f-strings (#1752).
 *
 * The shipped grammar routes every `f'`/`f"` prefix — one quote or three, via
 * `f'{1,3}` — into its single-line f-string states, whose first rule pops the
 * whole stack at end of line. A multi-line `f"""…"""` therefore loses its
 * string state after the opening line, its body is tokenized as code, and the
 * *closing* `"""` then opens a fresh docstring state — so everything below the
 * f-string renders as one endless string. Plain `"""` docstrings are unaffected
 * (they have their own multi-line states).
 *
 * The returned grammar routes triple-quoted f-strings — every prefix spelling,
 * `f'''`/`F"""`/`rf'''`/`fR"""`/… — into new multi-line states modelled on the
 * grammar's own `endDocString`/`endDblDocString`, plus its `@fStringDetail`
 * interpolation handling. Everything else is shared with the input grammar by
 * reference.
 *
 * Deliberately all-or-nothing: if the `strings` state no longer contains the
 * exact rules being replaced (or the new state names appear), a monaco upgrade
 * has changed the grammar — return it untouched rather than guess.
 */
export function withMultilineFStringFix(
  language: Monaco.languages.IMonarchLanguage,
): Monaco.languages.IMonarchLanguage {
  const strings = language.tokenizer['strings']
  if (!Array.isArray(strings)) return language
  if ('fEndDocString' in language.tokenizer || 'fEndDblDocString' in language.tokenizer) {
    return language
  }

  // Prefix coverage matches the pending upstream fix
  // (microsoft/monaco-editor#5272): every f-string spelling — `F`, `rf`, `fR`,
  // `Rf`, … — gets the f-string states, not just bare lowercase `f`. Two rules
  // per quote length because a single alternation can't say "f and r in either
  // order, r optional" without also matching a lone `r`.
  let replaced = 0
  const patchedStrings = strings.flatMap((rule): MonarchRule[] => {
    switch (ruleRegexSource(rule)) {
      case "f'{1,3}":
        replaced += 1
        return [
          [/[fF][rR]?'''/, 'string.escape', '@fEndDocString'],
          [/[rR][fF]'''/, 'string.escape', '@fEndDocString'],
          [/[fF][rR]?'/, 'string.escape', '@fStringBody'],
          [/[rR][fF]'/, 'string.escape', '@fStringBody'],
        ]
      case 'f"{1,3}':
        replaced += 1
        return [
          [/[fF][rR]?"""/, 'string.escape', '@fEndDblDocString'],
          [/[rR][fF]"""/, 'string.escape', '@fEndDblDocString'],
          [/[fF][rR]?"/, 'string.escape', '@fDblStringBody'],
          [/[rR][fF]"/, 'string.escape', '@fDblStringBody'],
        ]
      default:
        return [rule]
    }
  })
  if (replaced !== 2) return language

  return {
    ...language,
    tokenizer: {
      ...language.tokenizer,
      strings: patchedStrings,
      // `endDocString`/`endDblDocString` with the single-line f-string states'
      // interpolation rule spliced in. Ordered so runs of plain text are
      // consumed first, `{{`/`}}` stay literal braces (the single-line states
      // get this wrong too, but there the damage ends at the line break —
      // here it would swallow whole lines into @fStringDetail), `{expr` opens
      // interpolation, the closing triple quote wins over a lone quote, and
      // stray quotes/braces stay string-coloured.
      fEndDocString: [
        [/[^'{}]+/, 'string'],
        [/\{\{|\}\}/, 'string'],
        [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
        [/'''/, 'string', '@popall'],
        [/'/, 'string'],
        [/[{}]/, 'string'],
      ],
      fEndDblDocString: [
        [/[^"{}]+/, 'string'],
        [/\{\{|\}\}/, 'string'],
        [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
        [/"""/, 'string', '@popall'],
        [/"/, 'string'],
        [/[{}]/, 'string'],
      ],
    },
  }
}

/** The regex source of a short-form Monarch rule, or undefined for any other shape. */
function ruleRegexSource(rule: MonarchRule): string | undefined {
  if (!Array.isArray(rule)) return undefined
  const [regex] = rule
  if (regex instanceof RegExp) return regex.source
  if (typeof regex === 'string') return regex
  return undefined
}
