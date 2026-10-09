import { basename } from 'node:path'
import { parse as parseShellCommand } from 'shell-quote'

/**
 * Shared shell-lexing primitives for the security analyzers.
 *
 * `shell-scope.ts` (scope classification), `command-routing.ts` (trusted-command
 * routing), and `shell-harm.ts` (the Guarded YOLO harm gate) all need the same
 * four things: split a command line into argv arrays, look through wrappers that
 * do not change what runs, recognise an interpreter, and recognise a script
 * operand or inline-code flag. Each had grown its own copy, and the copies had
 * drifted — three interpreter sets, three script-extension patterns, two
 * inline-flag lists, and two wrapper lists that disagreed about `timeout`,
 * `sudo`, and `env`. This module is the single source; the analyzers layer their
 * own policy on top of it.
 *
 * Nothing here makes a security decision. Every consumer only ever *adds*
 * reasons from what it sees, so over-segmentation and over-broad matching are
 * safe in the sense that matters: they can cause an extra prompt, never a silent
 * auto-run.
 */

/** Interpreters that are also login shells — they accept `-c` and a script path. */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/**
 * Interpreters whose input is a *shell command language*: the POSIX shells plus
 * PowerShell, whose command lines the argv inspectors also model (`Remove-Item`,
 * `takeown`, `reg delete`).
 *
 * The complement of this set within {@link CODE_INTERPRETERS} — `node`,
 * `python`, `ruby`, `perl` — takes source in a language that is not shell at
 * all. Lexing that source as a command line invents commands nobody wrote, so
 * the harm gate uses this set to decide how to read a body it is handed.
 */
export const SHELL_LANGUAGE_INTERPRETERS: ReadonlySet<string> = new Set([
  ...SHELL_INTERPRETERS,
  'pwsh',
  'powershell',
])

/**
 * Executables whose first operand (or `-c`/`-e` body) is code this analysis
 * cannot see through without reading it. A superset of {@link SHELL_INTERPRETERS}.
 */
export const CODE_INTERPRETERS: ReadonlySet<string> = new Set([
  ...SHELL_INTERPRETERS,
  'node',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'pwsh',
  'powershell',
])

/**
 * Script-file suffixes, as a regex alternation so callers can embed it in a
 * larger pattern (`shell-scope.ts` matches interpreter-plus-file in one regex)
 * as well as test a bare token. Previously three separate literals, one of which
 * carried a comment promising it was "kept byte-for-byte in sync" with another.
 */
export const SCRIPT_EXTENSION_ALTERNATION = 'sh|bash|zsh|js|cjs|mjs|ts|mts|cts|py|rb|pl|ps1|cmd|bat'

/** Matches a token ending in a recognised script suffix. */
export const SCRIPT_EXTENSIONS = new RegExp(`\\.(?:${SCRIPT_EXTENSION_ALTERNATION})$`, 'i')

/** Flags whose next argument is an inline code body rather than a file. */
export const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(['-c', '-e', '--eval', '-Command'])

interface WrapperSpec {
  /** Also consume leading `VAR=value` assignments (`env FOO=1 cmd`). */
  assignments?: boolean
  /** Also consume a bare numeric operand (`timeout 5 cmd`). */
  numeric?: boolean
  /**
   * Options whose value is a *separate* argument. Without these the value itself
   * becomes argv[0]: `sudo -u root rm -rf /` left `root` as the head, so the real
   * `rm -rf /` was never inspected and a hard deny degraded to a bare prompt.
   */
  valueFlags?: ReadonlySet<string>
}

/**
 * Commands that execute their tail unchanged. Looking through them is always
 * correct for *analysis*: `timeout 5 rm -rf ~` deletes the home directory just
 * as `rm -rf ~` does, and a gate that only sees `timeout` sees nothing.
 */
export const PASS_THROUGH_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
  ['env', { assignments: true, valueFlags: new Set(['-u', '--unset', '-C', '--chdir']) }],
  ['timeout', { numeric: true, valueFlags: new Set(['-s', '--signal', '-k', '--kill-after']) }],
  ['stdbuf', { numeric: true, valueFlags: new Set(['-i', '-o', '-e']) }],
  [
    'xargs',
    {
      valueFlags: new Set([
        '-n',
        '-L',
        '-I',
        '-i',
        '-P',
        '-s',
        '-E',
        '-d',
        '-a',
        '--max-args',
        '--max-procs',
        '--replace',
        '--delimiter',
      ]),
    },
  ],
  ['time', { valueFlags: new Set(['-f', '--format', '-o', '--output']) }],
  ['nice', { valueFlags: new Set(['-n', '--adjustment']) }],
  ['ionice', { valueFlags: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid']) }],
  ['command', {}],
  ['builtin', {}],
  ['exec', {}],
  ['nohup', {}],
  [
    'sudo',
    {
      valueFlags: new Set([
        '-u',
        '--user',
        '-g',
        '--group',
        '-U',
        '-p',
        '--prompt',
        '-C',
        '-h',
        '--host',
        '-r',
        '--role',
        '-t',
        '--type',
        '-D',
        '--chdir',
      ]),
    },
  ],
  ['doas', { valueFlags: new Set(['-u', '-C']) }],
])

/**
 * The subset of {@link PASS_THROUGH_WRAPPERS} that trusted-command routing may
 * look through when resolving which binary a user's allow-list entry authorises.
 *
 * Deliberately narrower, and the asymmetry is the point. For harm analysis,
 * seeing *deeper* is always safer. For routing, seeing deeper is a privilege
 * grant: if `commandHead('sudo xcodebuild')` resolved to `xcodebuild`, an
 * allow-list entry for `xcodebuild` would silently authorise running it as root.
 * So every wrapper that confers privilege (`sudo`), rewrites the environment
 * (`env`), or takes a command as data (`xargs`, `command`) is excluded here and
 * left to surface as the segment head, where `command-routing.ts` rejects it.
 */
export const TRUST_TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  'nohup',
  'nice',
  'stdbuf',
  'time',
  'builtin',
])

/**
 * Command basenames that only read. Exported so `read-outside-project.ts` can
 * build its own (slightly wider) read shape on top of this one instead of
 * restating it — two lists of "which commands only read" would drift.
 */
export const READ_ONLY_SHELL_BASENAMES: ReadonlySet<string> = new Set([
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'fd',
  'tree',
  'stat',
  'file',
  'du',
  'jq',
  'cut',
  'tr',
  'basename',
  'dirname',
  'realpath',
])

/**
 * Git subcommands that only read. Exported so the auto-approval classifier can
 * build its (wider) read set as a superset of this one rather than restating it —
 * two independent lists of "which git subcommands are safe to read" would drift.
 */
export const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'grep',
  'ls-files',
  'ls-tree',
  'cat-file',
  'rev-parse',
])

/**
 * Conservative structural read-only check for shell commands. This is not a
 * sandbox boundary; callers must compose it with normal scope analysis. It only
 * recognizes simple read/query commands and pipelines thereof, rejecting shell
 * control flow, redirection, substitutions, and command families with common
 * mutating modes.
 *
 * Lives here rather than in `permission-policy.ts` (which re-exports it) because
 * `shell-scope.ts` needs it too, and `permission-policy.ts` already imports
 * `shell-scope.ts` — this module is the leaf both can depend on.
 */
export function isStructurallyReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  // A newline separates commands exactly as `;` does, but `shell-quote` lexes it
  // as plain whitespace: `cat x\nrm -rf src` would read as one `cat`.
  if (/[`$<>&();\r\n]|\|\|/.test(trimmed) || trimmed.includes('&&')) return false
  const segments = trimmed.split('|').map((segment) => segment.trim())
  return segments.length > 0 && segments.every(isReadOnlySimpleCommand)
}

/**
 * Whether a single simple command (no pipeline, no control operators) is a
 * read/query invocation. Exported for the auto-approval classifier, which does
 * its own quote-aware segmentation and needs the per-segment verdict rather than
 * {@link isStructurallyReadOnlyShellCommand}'s whole-line one.
 */
export function isReadOnlySimpleCommand(segment: string): boolean {
  if (/[\r\n]/.test(segment)) return false
  let tokens: ReturnType<typeof parseShellCommand>
  try {
    tokens = parseShellCommand(segment)
  } catch {
    return false
  }
  if (tokens.length === 0 || !tokens.every((token) => typeof token === 'string')) {
    return false
  }

  const argv = tokens
  const name = basename(argv[0] ?? '')
  if (!name) return false
  if (name === 'git') return isReadOnlyGitCommand(argv)
  if (name === 'sed') return isReadOnlySedCommand(argv)
  if (!READ_ONLY_SHELL_BASENAMES.has(name)) return false
  return !argv.slice(1).some((arg) => isEscapeHatchFlag(name, arg))
}

/** Long options that leave `sed` a pure filter. Anything else disqualifies it. */
const SED_INERT_LONG_FLAGS: ReadonlySet<string> = new Set([
  '--quiet',
  '--silent',
  '--regexp-extended',
  '--null-data',
  '--posix',
  '--separate',
  '--unbuffered',
  '--debug',
  '--sandbox',
  '--follow-symlinks',
  '--help',
  '--version',
])

/** Short option letters with the same property (`-n`, `-E`/`-r`, `-s`, `-u`, `-z`). */
const SED_INERT_SHORT_FLAGS = 'nEsuzr'

/**
 * Script letters that make `sed` more than a filter: `w`/`W` write a file,
 * `r`/`R` read one, and `e` (GNU) executes a command.
 */
const SED_SCRIPT_ACTIVE_LETTERS = /[wWrRe]/

/**
 * `sed` is the one line-oriented reader agents reach for that the basename
 * allow-list cannot admit wholesale: `-i` rewrites its input, `-f` runs a script
 * file, and the script language itself can write, read, or execute. This admits
 * it only in the shape that is provably a filter:
 *
 * - no in-place edit (`-i`, `-I`, `--in-place`), no script file (`-f`,
 *   `--file`), and no option this table does not know — `-l`/`--line-length`
 *   take a value and are refused rather than parsed;
 * - every script (positional or via `-e`/`--expression`) is free of the letters
 *   that name an active command. A sed script is a small language this module
 *   does not parse, so the test is letter-level: `s/hello/world/` is refused
 *   for the `w` and `r` in its replacement text and keeps prompting as it does
 *   today, while the line-selection shapes steering prompts hand agents
 *   (`sed -n '1,320p' FILE`, `sed -n '5p;10p'`, `sed -n '/^## /p'`) are
 *   admitted.
 *
 * Refusal only ever means the command prompts, which was the status quo; the
 * read-outside-project grant still keeps its own head list and stays unchanged.
 */
export function isReadOnlySedCommand(argv: readonly string[]): boolean {
  const scripts: string[] = []
  const positional: string[] = []
  let expressionSeen = false
  let expectScript = false
  let filesOnly = false
  for (const arg of argv.slice(1)) {
    if (expectScript) {
      scripts.push(arg)
      expectScript = false
      continue
    }
    if (filesOnly || arg === '-' || !arg.startsWith('-')) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      filesOnly = true
      continue
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const flag = equals === -1 ? arg : arg.slice(0, equals)
      if (flag === '--expression') {
        expressionSeen = true
        if (equals === -1) expectScript = true
        else scripts.push(arg.slice(equals + 1))
        continue
      }
      if (!SED_INERT_LONG_FLAGS.has(flag)) return false
      continue
    }
    // Short bundle (`-n`, `-nE`, `-ne SCRIPT`, `-eSCRIPT`).
    for (let index = 1; index < arg.length; index += 1) {
      const letter = arg.charAt(index)
      if (letter === 'e') {
        expressionSeen = true
        const attached = arg.slice(index + 1)
        if (attached) scripts.push(attached)
        else expectScript = true
        break
      }
      if (!SED_INERT_SHORT_FLAGS.includes(letter)) return false
    }
  }
  if (expectScript) return false
  if (!expressionSeen) {
    const script = positional.shift()
    if (script === undefined) return false
    scripts.push(script)
  }
  return scripts.every((script) => !SED_SCRIPT_ACTIVE_LETTERS.test(script))
}

/**
 * Flags that turn one of the allow-listed commands above into a launcher or a
 * writer. The allow-list is by basename, so without these a "read-only" command
 * runs whatever it is pointed at: `sort --compress-program=./x.sh` executes
 * `./x.sh` on its temporary files and `fd -x ./x.sh` executes it once per
 * result — while `./x.sh` on its own line is opaque local execution and
 * prompts. `git` gets the same treatment a few lines below, and `rg --pre` was
 * already handled here; these are its siblings.
 *
 * Per command, never global: `grep -o` is "only matching", not an output file.
 */
const ESCAPE_HATCH_FLAGS: ReadonlyMap<string, { short: string; long: ReadonlySet<string> }> =
  new Map([
    // -o/--output write the result to a file; --compress-program runs a program.
    ['sort', { short: 'o', long: new Set(['--output', '--compress-program']) }],
    // -x/--exec and -X/--exec-batch run a command per result / once for all.
    ['fd', { short: 'xX', long: new Set(['--exec', '--exec-batch']) }],
    // -o sends output to a file.
    ['tree', { short: 'o', long: new Set(['--output']) }],
    // --pre preprocesses each file through a program; --hostname-bin runs one.
    ['rg', { short: '', long: new Set(['--pre', '--hostname-bin']) }],
    // -C compiles the magic file named by -m, writing it out.
    ['file', { short: 'C', long: new Set(['--compile']) }],
  ])

function isEscapeHatchFlag(command: string, arg: string): boolean {
  const hatches = ESCAPE_HATCH_FLAGS.get(command)
  if (!hatches) return false
  if (arg.startsWith('--')) {
    const equals = arg.indexOf('=')
    return hatches.long.has(equals === -1 ? arg : arg.slice(0, equals))
  }
  // A short flag may arrive bundled (`sort -uo out.txt`), so look at every
  // character rather than comparing the token whole. A bare `-` is stdin.
  if (!arg.startsWith('-') || arg.length < 2) return false
  for (let index = 1; index < arg.length; index += 1) {
    if (hatches.short.includes(arg.charAt(index))) return true
  }
  return false
}

function isReadOnlyGitCommand(argv: readonly string[]): boolean {
  const subcommand = argv[1]
  if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
  return !hasGitReadEscapeHatch(subcommand, argv.slice(2))
}

export function hasGitReadEscapeHatch(subcommand: string, args: readonly string[]): boolean {
  return args.some((arg) => isGitEscapeHatchFlag(subcommand, arg))
}

function isGitEscapeHatchFlag(subcommand: string, arg: string): boolean {
  if (
    arg === '-o' ||
    arg === '-O' ||
    isLongFlagOrAbbreviation(arg, '--output') ||
    isLongFlagOrAbbreviation(arg, '--exec')
  ) {
    return true
  }

  // `git grep -O<pager>` / `--open-files-in-pager=<pager>` executes the
  // supplied pager. Short options may be bundled (`-nO./tool`), so inspect
  // every short-option character just as the simple-command table does above.
  if (subcommand === 'grep') {
    if (isLongFlagOrAbbreviation(arg, '--open-files-in-pager')) return true
    if (/^-[^-]*O/.test(arg)) return true
  }

  // These opt into repository-configured external diff, text-conversion,
  // or working-tree filter programs. They are reads only until the helper runs.
  if (isLongFlagOrAbbreviation(arg, '--ext-diff') || isLongFlagOrAbbreviation(arg, '--textconv')) {
    return true
  }
  if (subcommand === 'cat-file' && isLongFlagOrAbbreviation(arg, '--filters')) return true

  return false
}

/**
 * Real Git long options that happen to be a prefix of an escape hatch. Git
 * resolves these as exact matches, never as an abbreviation of the longer
 * name, so they stay plain reads: `git grep --text` is `-a`, and
 * `git cat-file --batch-check --filter=<spec>` narrows the batch.
 */
const DISTINCT_PREFIX_OPTIONS = new Set(['--text', '--filter'])

function isLongFlagOrAbbreviation(arg: string, flag: string): boolean {
  if (!arg.startsWith('--')) return false
  const equals = arg.indexOf('=')
  const name = equals === -1 ? arg : arg.slice(0, equals)
  if (name === flag) return true
  // Git's option parser accepts any prefix that is unique among the
  // subcommand's options — there is no minimum length, so `git grep --op=`
  // runs the pager just as `--open-files-in-pager=` does. Every prefix of a
  // launcher is therefore treated as the launcher, apart from the handful of
  // genuine options above: a rejected abbreviation merely prompts, while an
  // accepted launcher must never inherit read-only classification.
  if (name.length <= 2 || DISTINCT_PREFIX_OPTIONS.has(name)) return false
  return flag.startsWith(name)
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The path-stripped, lowercased executable name of an argv, for set lookups. */
export function commandName(argv0: string | undefined): string {
  return basename(argv0 ?? '').toLowerCase()
}

/**
 * Whether an argv invokes the shell's `printf -v name …` assignment form.
 *
 * `printf` normally only writes bytes, but Bash and Zsh implement `-v` as a
 * shell builtin that writes a variable in the current shell. In a compound
 * command, `printf -v PATH /tmp/evil && git …` can therefore replace the next
 * executable without containing a leading `NAME=value` token. Authorization
 * paths that treat ordinary `printf` as inert must reject this form.
 */
export function printfAssignsShellVariable(argv: readonly string[]): boolean {
  if (commandName(argv[0]) !== 'printf') return false
  for (const arg of argv.slice(1)) {
    if (arg === '--') return false
    if (arg === '-v' || arg.startsWith('-v')) return true
    if (!arg.startsWith('-') || arg === '-') return false
  }
  return false
}

/**
 * Drop leading environment assignments and pass-through wrappers until the argv
 * starts at the command that actually runs.
 */
export function unwrapWrappers(argv: readonly string[]): string[] {
  return unwrap(argv, [])
}

/**
 * Every word {@link unwrapWrappers} looks through on the way to the command: each
 * wrapper's name and each leading `NAME=value` assignment, outermost first. A
 * grant must judge the whole chain — `nohup env HOME=/root cat …` hides its `env`
 * behind a transparent `nohup`.
 */
export function wrapperChain(argv: readonly string[]): string[] {
  const chain: string[] = []
  unwrap(argv, chain)
  return chain
}

function unwrap(argv: readonly string[], chain: string[]): string[] {
  const current = [...argv]
  for (;;) {
    while (ASSIGNMENT.test(current[0] ?? '')) chain.push(current.shift() ?? '')
    const spec = PASS_THROUGH_WRAPPERS.get(commandName(current[0]))
    if (!spec) return current
    chain.push(commandName(current.shift()))
    for (;;) {
      const next = current[0] ?? ''
      const consumable =
        next.startsWith('-') ||
        (spec.assignments === true && ASSIGNMENT.test(next)) ||
        (spec.numeric === true && /^\d/.test(next))
      if (!consumable) break
      current.shift()
      // `-u root` — the value is a separate argument, so drop it too. An attached
      // value (`-I{}`, `-n1`) was already consumed with the flag above.
      if (spec.valueFlags?.has(next) === true) current.shift()
    }
  }
}

/** The inline code body a `-c`/`-e`/`--eval`/`-Command` flag introduces, if any. */
export function inlineCodeBody(argv: readonly string[]): string | null {
  for (let index = 1; index < argv.length - 1; index += 1) {
    if (INLINE_CODE_FLAGS.has(argv[index] ?? '')) return argv[index + 1] ?? null
  }
  return null
}

/**
 * Quote-aware token split that keeps every character the shell would pass to the
 * command, including Windows separators. `shell-quote` reads `C:\work\project` as
 * three escapes and yields `C:workproject`, which erases exactly the paths a
 * Windows harm check needs to see.
 */
function rawTokens(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => {
    const first = token[0]
    const last = token[token.length - 1]
    return (first === '"' && last === '"') || (first === "'" && last === "'")
      ? token.slice(1, -1)
      : token
  })
}

const RAW_REDIRECT_PREFIX = /^(?:\d*(?:<<<|<<|<&|<>|<|>>|>&|>\||>)|&>>?)(.*)$/

/**
 * Remove redirect syntax from the Windows-preserving fallback argv. The raw
 * separator split may isolate an attached redirect after an escaped terminator
 * (`find … \\; 2>/dev/null`), but the destination is still data, not a command.
 * Actual write targets remain visible to {@link shellRedirects}.
 */
function withoutRawRedirects(argv: string[]): string[] {
  const command: string[] = []
  let awaitingTarget = false
  for (const token of argv) {
    if (awaitingTarget) {
      awaitingTarget = false
      continue
    }
    const redirect = RAW_REDIRECT_PREFIX.exec(token)
    if (redirect) {
      awaitingTarget = redirect[1] === ''
      continue
    }
    command.push(token)
  }
  return command
}

/**
 * Quote-aware fallback argv for one already-separated shell segment. This keeps
 * Windows separators and unknown variable spellings while dropping redirects.
 */
export function rawShellArgv(segment: string): string[] {
  return withoutRawRedirects(rawTokens(segment))
}

/**
 * Argv arrays for every simple command in a command line, from two lexers whose
 * results are unioned:
 *
 * - `shell-quote`, which gets POSIX quoting, operators, and assignments right
 *   but eats Windows separators and (without the glob handling below) drops
 *   globbed operands entirely;
 * - {@link rawTokens} over a separator split, which is quote-aware but not
 *   operator-aware, and preserves both.
 *
 * Neither is complete, so callers see both. A consumer may therefore inspect the
 * same command twice and must dedupe its reasons — which they all do — and may
 * see a segment the shell would never execute as one, which costs at most an
 * extra prompt.
 */
/**
 * Operators that open a file for writing, mapped to whether they truncate it.
 * `>`, the clobber form `>|`, and the both-streams `&>` truncate; `>>` and `&>>`
 * append. `>&` is here too: with a word target (`>& file`) it is `&>` spelled the
 * csh way, and only a descriptor target (`2>&1`, `>&-`) makes it a duplication.
 */
const WRITE_REDIRECTS: ReadonlyMap<string, boolean> = new Map([
  ['>', true],
  ['>|', true],
  ['&>', true],
  ['>&', true],
  ['>>', false],
  ['&>>', false],
])

/** A `>&` target that names a descriptor (or closes one) rather than a file. */
const DESCRIPTOR_TARGET = /^(?:\d+|-)$/

/**
 * Every redirect operator, write or read. The token after any of these names a
 * file or file descriptor, never a command, so it must not become a segment head:
 * `tee out.txt < src/in.txt` was reporting "script contents could not be
 * inspected safely: src/in.txt" because `src/in.txt` looked like a relative
 * executable.
 */
const REDIRECTS = new Set([...WRITE_REDIRECTS.keys(), '<', '<<', '<<<', '<&'])

/**
 * `command` with the inside of every span the shell cannot expand replaced by
 * `x`, keeping each character in place so indexes still line up. That is a
 * single-quoted span, or a double-quoted one with no `$` or backtick in it.
 * Returns null when quoting is ambiguous (an unterminated quote, or `$'…'`
 * whose escapes differ), leaving the caller to over-segment.
 */
function maskInertQuotedText(command: string): string | null {
  let out = ''
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (char === '\\') {
      out += command.slice(index, index + 2)
      index++
      continue
    }
    if (char !== "'" && char !== '"') {
      out += char
      continue
    }
    if (char === "'" && command.charAt(index - 1) === '$') return null
    let end = index + 1
    while (end < command.length && command.charAt(end) !== char) {
      if (char === '"' && command.charAt(end) === '\\') end++
      end++
    }
    if (end >= command.length) return null
    const inner = command.slice(index + 1, end)
    out += char + (char === '"' && /[$`]/.test(inner) ? inner : 'x'.repeat(inner.length)) + char
    index = end
  }
  return out.length === command.length ? out : null
}

/**
 * The stricter split behind {@link shellSegmentsQuoteAware}. On top of the
 * single-quote masking {@link splitRawSegments} does, it also ignores separators
 * inside a double-quoted span that holds no `$` or backtick (`jq ".a | length"`),
 * and falls back to that split when quoting is ambiguous.
 */
function splitRawSegmentsQuoteAware(command: string): string[] {
  const masked = maskInertQuotedText(command)
  if (masked === null) return splitRawSegments(command)
  const segments: string[] = []
  let start = 0
  for (const match of masked.matchAll(RAW_SEPARATORS)) {
    segments.push(command.slice(start, match.index))
    start = match.index + match[0].length
  }
  segments.push(command.slice(start))
  return segments
}

/**
 * shell-quote treats newlines as argument whitespace and comments as extending
 * to the end of its input. Give it one command line at a time, preserving quoted
 * newlines and backslash continuations as part of the original input.
 */
function splitShellCommandLines(command: string): string[] {
  const lines: string[] = []
  let start = 0
  let quote: "'" | '"' | null = null
  let comment = false
  let wordStarted = false
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (char === '\n' && (comment || quote === null)) {
      lines.push(command.slice(start, index))
      start = index + 1
      comment = false
      wordStarted = false
      continue
    }
    if (comment) continue
    if (char === '\\' && quote !== "'") {
      if (command.charAt(index + 1) !== '\n') wordStarted = true
      index++
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      wordStarted = true
    } else if (char === '#' && !wordStarted) {
      comment = true
    } else {
      wordStarted = !/[\s;&|()<>]/.test(char)
    }
  }
  lines.push(command.slice(start))
  return lines
}

export function shellSegments(command: string, includeRawFallback = true): string[][] {
  return collectSegments(command, includeRawFallback, false)
}

/**
 * {@link shellSegments} for the classifiers that decide whether a command is
 * *opaque or a plain read*, where an invented segment head is a false alarm
 * (a sed character class split at its `;`). The fallback pass still runs, but
 * does not split inside quoted text the shell cannot expand.
 *
 * The harm gate, host-reach, and the other hard checks keep {@link shellSegments}:
 * they read code out of quoted `-c` bodies and rely on the blunt split to do it.
 */
export function shellSegmentsQuoteAware(command: string): string[][] {
  return collectSegments(command, true, true)
}

function collectSegments(
  command: string,
  includeRawFallback: boolean,
  quoteAware: boolean,
): string[][] {
  const segments: string[][] = []

  let tokens: ReturnType<typeof parseShellCommand> | null
  try {
    tokens = []
    for (const line of splitShellCommandLines(command)) {
      tokens.push(...parseShellCommand(line), { op: ';' })
    }
  } catch {
    tokens = null
  }
  if (tokens) {
    let current: string[] = []
    let awaitingRedirectTarget = false
    const flush = (): void => {
      if (current.length > 0) segments.push(current)
      current = []
    }
    for (const token of tokens) {
      if (typeof token === 'string') {
        // The word after `>` is a file the shell opens, not a command to run.
        // Treating it as a segment head made `echo x >> ~/.bashrc` report
        // "script contents could not be inspected safely: ~/.bashrc" — the gate
        // thought the redirect target was an executable. Redirect targets are
        // inspected as writes, via `shellRedirects`.
        if (awaitingRedirectTarget) {
          awaitingRedirectTarget = false
          continue
        }
        current.push(token)
        continue
      }
      // A glob is still an operand — `rm -rf ~/*` targets the home directory.
      // Flushing here (the previous behaviour) discarded the target and left the
      // gate looking at a bare `rm -rf`.
      if ('op' in token && token.op === 'glob') {
        current.push(token.pattern)
        continue
      }
      if ('op' in token && REDIRECTS.has(token.op)) {
        awaitingRedirectTarget = true
        continue
      }
      flush()
    }
    flush()
  }

  // Hard-deny consumers must not treat a separator inside quoted data as code.
  if (!includeRawFallback) return segments

  // The `&` of a redirect (`2>&1`, `<&3`, `&>log`) separates nothing. Splitting on it
  // made `1` a command head, and that phantom head's "not a plain read" blocker
  // laundered a credential read: `ls ~/.ssh/id_* 2>&1` escaped the hard deny.
  for (const segment of quoteAware
    ? splitRawSegmentsQuoteAware(command)
    : splitRawSegments(command)) {
    const argv = rawShellArgv(segment)
    if (argv.length > 0) segments.push(argv)
  }

  return segments
}

const RAW_SEPARATORS = /&&|\|\||(?<![<>])&(?!>)|[;|(\r\n]+/g

/**
 * Blank the separator characters inside a closed, single-line `'…'` span. The
 * shell never expands single quotes, so `;` in `sed 's/a;b/c/'` starts nothing.
 * Double quotes are left alone because `"$(a; b)"` does run `b`, and so is any
 * `'` that has no closing partner on its line (an apostrophe in a heredoc body or
 * comment) so an unbalanced quote can only add segments, never hide one.
 */
function maskSingleQuotedSeparators(command: string): string {
  let out = ''
  let index = 0
  let inDouble = false
  while (index < command.length) {
    const char = command.charAt(index)
    if (char === '\\') {
      out += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === '"') inDouble = !inDouble
    if (char === "'" && !inDouble) {
      const end = command.indexOf("'", index + 1)
      const span = end === -1 ? '' : command.slice(index, end + 1)
      if (end !== -1 && !/[\r\n]/.test(span)) {
        out += span.replace(/[;|&(]/g, '_')
        index = end + 1
        continue
      }
    }
    out += char
    index++
  }
  return out
}

/** `command.split(RAW_SEPARATORS)` that ignores separators inside single quotes. */
function splitRawSegments(command: string): string[] {
  const masked = maskSingleQuotedSeparators(command)
  const pieces: string[] = []
  let start = 0
  for (const match of masked.matchAll(RAW_SEPARATORS)) {
    pieces.push(command.slice(start, match.index))
    start = match.index + match[0].length
  }
  pieces.push(command.slice(start))
  return pieces
}

export interface ShellRedirect {
  target: string
  /** True for `>` — the file's previous contents are gone whether or not the write succeeds. */
  truncates: boolean
}

/** Whether a command redirects descriptor 0 from a file, heredoc/string, or another descriptor. */
export function hasShellInputRedirect(command: string): boolean {
  // Let the shared parser reject malformed source, then retain the source text so
  // `3< file` (descriptor 3) can be distinguished from `< file` (stdin). The
  // parser's token stream drops that adjacency and reports both as the same `<`.
  try {
    parseShellCommand(command)
  } catch {
    return false
  }
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (quote !== null) {
      if (quote === '"' && char === '\\') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '\\') {
      index++
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char !== '<' || command.charAt(index + 1) === '(') continue

    let digitStart = index
    while (digitStart > 0 && /\d/.test(command.charAt(digitStart - 1))) digitStart--
    if (digitStart === index) return true
    const beforeDigits = command.charAt(digitStart - 1)
    // Digits are an IO-number only when they begin a shell word. In `arg3<file`,
    // `arg3` remains an argument and the redirect still targets stdin.
    if (digitStart > 0 && !/[\s;&|()]/.test(beforeDigits)) return true
    if (/^0+$/.test(command.slice(digitStart, index))) return true
  }
  return false
}

/**
 * Files a command line opens for writing via redirection.
 *
 * A redirect is the plainest destructive verb the shell has and it has no command
 * name at all, so no argv-based inspector can see it: `echo "" > /etc/passwd`
 * erases the password file with nothing in argv but `echo`. File-descriptor
 * duplication (`2>&1`, `>&-`) is deliberately excluded — it writes no file.
 */
export function shellRedirects(command: string): ShellRedirect[] {
  let tokens: ReturnType<typeof parseShellCommand>
  try {
    tokens = parseShellCommand(command)
  } catch {
    return []
  }
  const redirects: ShellRedirect[] = []
  let pending: boolean | null = null
  let duplicates = false
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (pending !== null && !(duplicates && DESCRIPTOR_TARGET.test(token))) {
        redirects.push({ target: token, truncates: pending })
      }
      pending = null
      continue
    }
    if ('op' in token && token.op === 'glob') {
      if (pending !== null) {
        redirects.push({ target: token.pattern, truncates: pending })
        pending = null
      }
      continue
    }
    pending = 'op' in token ? (WRITE_REDIRECTS.get(token.op) ?? null) : null
    duplicates = 'op' in token && token.op === '>&'
  }
  return redirects
}

/**
 * Files a command line reads through `<` (a plain input redirect). Heredocs and
 * here-strings carry text, not a path, and `<&` names a descriptor.
 */
export function shellInputRedirects(command: string): string[] {
  let tokens: ReturnType<typeof parseShellCommand>
  try {
    tokens = parseShellCommand(command)
  } catch {
    return []
  }
  const targets: string[] = []
  let pending = false
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (pending) targets.push(token)
      pending = false
      continue
    }
    pending = 'op' in token && token.op === '<'
  }
  return targets
}

/** Characters a literal value may hold and still expand to exactly itself unquoted. */
const LITERAL_VALUE = String.raw`[A-Za-z0-9_.\/+:@%,=-]+`
const LEADING_LITERAL_ASSIGNMENT = new RegExp(
  String.raw`^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:'(${LITERAL_VALUE})'|"(${LITERAL_VALUE})"|(${LITERAL_VALUE}))[ \t]*(?:;|&&|\n)\s*`,
)
/** Variables the shell or dynamic linker reads, so an assignment is more than a name. */
const BEHAVIOUR_VARIABLE =
  /^(?:PATH|IFS|HOME|SHELL|ENV|CDPATH|GLOBIGNORE|TMPDIR|PS4|PROMPT_COMMAND|LD_\w*|DYLD_\w*|BASH\w*)$/

/**
 * Replace `NAME=/literal/path; cmd "$NAME"` with `cmd "/literal/path"`.
 *
 * A path held in a variable is invisible to every path check here, so the
 * commonest way agents name a log (`L=/tmp/x.log; tail "$L"`) was unclassifiable.
 * Only leading statements whose value is a plain word are folded in, and only
 * when nothing later reassigns the name, so the result is what the shell would
 * have run. Anything else returns the command unchanged.
 */
export function inlineLeadingLiteralAssignments(command: string): string {
  let rest = command
  for (;;) {
    const match = LEADING_LITERAL_ASSIGNMENT.exec(rest)
    const name = match?.[1]
    if (match === null || name === undefined || BEHAVIOUR_VARIABLE.test(name)) return rest
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    const tail = rest.slice(match[0].length)
    if (new RegExp(String.raw`\b${name}=`).test(tail)) return rest
    rest = tail.replace(
      new RegExp(String.raw`\$\{${name}\}|\$${name}(?![A-Za-z0-9_])`, 'g'),
      () => value,
    )
  }
}
