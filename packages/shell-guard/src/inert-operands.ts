import { commandName, isReadOnlySedCommand } from './shell-argv.ts'

/**
 * Arguments a program reads as text and never opens: the pattern of a `grep` or
 * `rg` search. `grep -rn "/usr/local/bin" src` and `grep -v "//"` name no file
 * outside the workspace, yet every path scanner here saw an absolute path (and
 * `//` as the filesystem root) and prompted or refused.
 *
 * Recognition is an allow-list and fails closed. Every flag in a segment must be
 * one this module knows, with its arity; one unknown flag and nothing in that
 * segment is inert. The direction matters: mistaking a value-taking flag for a
 * switch shifts the operands left, so a real file operand would be read as the
 * pattern and disappear from analysis — `rg --pre /tmp/tool pattern` must never
 * report `/tmp/tool` as a pattern. Flag values other than an explicit pattern
 * (`-e`, `--regexp`) are never inert.
 */

interface SearchFlags {
  /** Single-letter switches that take no value. */
  shortSwitches: string
  /** Single-letter options that take a value (attached or as the next word). */
  shortValued: string
  longSwitches: ReadonlySet<string>
  /** Long options that take a value, attached (`--max-count=3`) or as the next word. */
  longValued: ReadonlySet<string>
  /**
   * Long options whose value is optional, so it may only be attached: BSD grep's
   * `--context` alone means "two lines", and reading the next word as its value
   * would shift every operand after it.
   */
  longAttachedOnly: ReadonlySet<string>
  /** Flags that switch the tool to a mode with no pattern operand at all. */
  noPattern: ReadonlySet<string>
}

const GREP_FLAGS: SearchFlags = {
  shortSwitches: 'abcEFGHhIiLlnOoPpqRrSsTUuVvwxZz',
  shortValued: 'ABCDdefm',
  longSwitches: new Set([
    '--basic-regexp',
    '--binary',
    '--byte-offset',
    '--color',
    '--colour',
    '--count',
    '--dereference-recursive',
    '--extended-regexp',
    '--files-with-matches',
    '--files-without-match',
    '--fixed-strings',
    '--ignore-case',
    '--initial-tab',
    '--invert-match',
    '--line-buffered',
    '--line-number',
    '--line-regexp',
    '--no-filename',
    '--no-ignore-case',
    '--no-messages',
    '--null',
    '--null-data',
    '--only-matching',
    '--perl-regexp',
    '--quiet',
    '--recursive',
    '--silent',
    '--text',
    '--with-filename',
    '--word-regexp',
  ]),
  longValued: new Set([
    '--after-context',
    '--before-context',
    '--devices',
    '--directories',
    '--exclude',
    '--exclude-dir',
    '--exclude-from',
    '--file',
    '--include',
    '--max-count',
    '--regexp',
  ]),
  longAttachedOnly: new Set(['--binary-files', '--color', '--colour', '--context']),
  noPattern: new Set(),
}

const RG_FLAGS: SearchFlags = {
  shortSwitches: '.0abcFHIiLlNnoPpqSsUuvwxz',
  shortValued: 'ABCdEefgjMmrTt',
  longSwitches: new Set([
    '--column',
    '--count',
    '--count-matches',
    '--case-sensitive',
    '--files',
    '--files-with-matches',
    '--files-without-match',
    '--fixed-strings',
    '--follow',
    '--heading',
    '--hidden',
    '--ignore-case',
    '--invert-match',
    '--json',
    '--line-number',
    '--line-regexp',
    '--multiline',
    '--multiline-dotall',
    '--no-config',
    '--no-filename',
    '--no-heading',
    '--no-ignore',
    '--no-ignore-vcs',
    '--no-line-number',
    '--no-messages',
    '--null',
    '--one-file-system',
    '--only-matching',
    '--pcre2',
    '--pretty',
    '--quiet',
    '--search-zip',
    '--smart-case',
    '--sort-files',
    '--stats',
    '--text',
    '--trim',
    '--type-list',
    '--unrestricted',
    '--vimgrep',
    '--with-filename',
    '--word-regexp',
  ]),
  longValued: new Set([
    '--after-context',
    '--before-context',
    '--color',
    '--colors',
    '--context',
    '--context-separator',
    '--encoding',
    '--field-match-separator',
    '--file',
    '--glob',
    '--iglob',
    '--ignore-file',
    '--max-columns',
    '--max-count',
    '--max-depth',
    '--max-filesize',
    '--path-separator',
    '--pre',
    '--pre-glob',
    '--regexp',
    '--replace',
    '--sort',
    '--sortr',
    '--threads',
    '--type',
    '--type-add',
    '--type-not',
  ]),
  longAttachedOnly: new Set(),
  noPattern: new Set(['--files', '--type-list']),
}

const SEARCH_TOOLS: ReadonlyMap<string, SearchFlags> = new Map([
  ['grep', GREP_FLAGS],
  ['egrep', GREP_FLAGS],
  ['fgrep', GREP_FLAGS],
  ['rg', RG_FLAGS],
])

const NONE: ReadonlySet<number> = new Set()

/**
 * The script operands of a `sed` that {@link isReadOnlySedCommand} proves is a
 * filter — no in-place edit, no script file, no read/write/execute command — so
 * `sed -n '/^## /p' ~/notes.md` reads the notes, not a file called `/^## /p`.
 * Same walk as the validator: `-e`/`--expression` values, else the first
 * positional.
 */
function sedScriptIndexes(argv: readonly string[]): ReadonlySet<number> {
  if (!isReadOnlySedCommand(argv)) return NONE
  const scripts = new Set<number>()
  let byExpression = false
  let firstPositional: number | null = null
  let filesOnly = false
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (filesOnly || arg === '-' || !arg.startsWith('-')) {
      firstPositional ??= i
      continue
    }
    if (arg === '--') {
      filesOnly = true
      continue
    }
    if (arg.startsWith('--')) {
      if (arg === '--expression' || arg.startsWith('--expression=')) byExpression = true
      if (arg === '--expression') scripts.add(++i)
      continue
    }
    // In a short bundle, `e` ends the flags: its script is attached (`-eSCRIPT`,
    // nothing to point at) or is the next word (`-ne SCRIPT`).
    const e = arg.indexOf('e')
    if (e === -1) continue
    byExpression = true
    if (e === arg.length - 1) scripts.add(++i)
  }
  if (!byExpression && firstPositional !== null) scripts.add(firstPositional)
  return scripts
}

const AWK_HEADS: ReadonlySet<string> = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/**
 * A regex literal where awk reads one: at the start of the program or after an
 * operator, never after an operand (`a / b / c` is division). A slash, newline
 * or unescaped `]` cannot end the scan early: `[/]` is a bracket expression.
 */
const AWK_REGEX_LITERAL = /(^|[\s{}();,!~&|?:])\/(?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\\\n[])*\//g
const AWK_STRING_LITERAL = /"(?:\\.|[^"\\\n])*"/g

/**
 * Whatever in an awk program can open a file, run a command or change a
 * variable a later file operand reads: output redirection and pipes (`print >`,
 * `| "cmd"`), `getline`, `system`, `close`, `fflush`, gawk's `@include` and
 * `@load` directives, and assignment to `ARGV`/`ARGC`, which re-points the
 * input files.
 */
const AWK_PROGRAM_ACTIVE = /[<>|@]|\b(?:getline|system|close|fflush|ARGV|ARGC)\b/

/**
 * Whether an awk program only filters its input. Regex and string literals are
 * removed first, so `/<\/script>/` is a pattern, not a redirect; what is left
 * must name none of {@link AWK_PROGRAM_ACTIVE}. Fails closed: an unrecognised
 * literal stays in the text, and any `<`, `>` or `|` left there refuses.
 */
function isFilterOnlyAwkProgram(program: string): boolean {
  const code = program
    .replace(AWK_STRING_LITERAL, '""')
    .replace(AWK_REGEX_LITERAL, (_match, lead: string) => `${lead}//`)
  return !AWK_PROGRAM_ACTIVE.test(code)
}

/**
 * The program operand of an awk that only filters, so
 * `awk '/^import/' src/a.ts` reads `src/a.ts`, not a file called `/^import/`.
 * Allow-list, failing closed: `-F` and `-v` (whose values stay live) are the
 * only flags understood, `-f` (program from a file) and every other flag find
 * nothing, and a program that can write, pipe or read beyond its operands is
 * never inert.
 */
function awkProgramIndexes(argv: readonly string[]): ReadonlySet<number> {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--') {
      const program = argv[i + 1]
      return program !== undefined && isFilterOnlyAwkProgram(program) ? new Set([i + 1]) : NONE
    }
    if (!arg.startsWith('-') || arg === '-') {
      return isFilterOnlyAwkProgram(arg) ? new Set([i]) : NONE
    }
    if (arg === '-F' || arg === '-v') {
      i++
      continue
    }
    if (arg.startsWith('-F') || arg.startsWith('-v')) continue
    return NONE
  }
  return NONE
}

/**
 * Indexes into `argv` of the words its program treats purely as a search
 * pattern or a filter script. Empty when the head is not a recognised search
 * tool, read-only `sed` or filter-only awk, or any flag is not understood.
 */
export function inertOperandIndexes(argv: readonly string[]): ReadonlySet<number> {
  if (commandName(argv[0]) === 'sed') return sedScriptIndexes(argv)
  if (AWK_HEADS.has(commandName(argv[0]))) return awkProgramIndexes(argv)
  const flags = SEARCH_TOOLS.get(commandName(argv[0]))
  if (!flags) return NONE
  const explicitPatterns = new Set<number>()
  const positional: number[] = []
  // A pattern given by flag (even an attached `-eX` we cannot point at) makes
  // every positional a file; patterns read from a file (`-f`) leave none to mask.
  let patternByFlag = false
  let patternless = false
  let optionsEnded = false
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] ?? ''
    if (optionsEnded || word === '-' || !word.startsWith('-')) {
      positional.push(i)
      continue
    }
    if (word === '--') {
      optionsEnded = true
      continue
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = eq === -1 ? word : word.slice(0, eq)
      const attached = eq !== -1
      if (flags.noPattern.has(name)) patternless = true
      if (name === '--regexp') patternByFlag = true
      if (name === '--file') patternless = true
      if (flags.longAttachedOnly.has(name)) continue
      if (flags.longSwitches.has(name)) {
        if (attached) return NONE
        continue
      }
      if (!flags.longValued.has(name)) return NONE
      if (attached) continue
      if (name === '--regexp') explicitPatterns.add(i + 1)
      i++
      continue
    }
    // A cluster of short flags: `-rn`, `-rnA3`, `-rne PATTERN`.
    for (let j = 1; j < word.length; j++) {
      const letter = word.charAt(j)
      if (flags.shortSwitches.includes(letter)) continue
      if (!flags.shortValued.includes(letter)) return NONE
      const attached = j < word.length - 1
      if (letter === 'e') {
        patternByFlag = true
        if (!attached) explicitPatterns.add(i + 1)
      }
      if (letter === 'f') patternless = true
      if (!attached) i++
      break
    }
  }
  if (patternless) return NONE
  if (patternByFlag) return explicitPatterns
  const first = positional[0]
  return first === undefined ? NONE : new Set([first])
}
