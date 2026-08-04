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
export const SCRIPT_EXTENSION_ALTERNATION = 'sh|bash|zsh|js|cjs|mjs|ts|py|rb|pl|ps1|cmd|bat'

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

const READ_ONLY_SHELL_BASENAMES = new Set([
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
  if (/[`$<>&();]|\|\|/.test(trimmed) || trimmed.includes('&&')) return false
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
  let tokens: ReturnType<typeof parseShellCommand>
  try {
    tokens = parseShellCommand(segment)
  } catch {
    return false
  }
  if (tokens.length === 0 || !tokens.every((token): token is string => typeof token === 'string')) {
    return false
  }

  const argv = tokens
  const name = basename(argv[0] ?? '')
  if (!name) return false
  if (name === 'git') return isReadOnlyGitCommand(argv)
  if (!READ_ONLY_SHELL_BASENAMES.has(name)) return false
  if (name === 'rg' && argv.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) {
    return false
  }
  return true
}

function isReadOnlyGitCommand(argv: readonly string[]): boolean {
  const subcommand = argv[1]
  if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
  return !argv
    .slice(2)
    .some(
      (arg) =>
        arg === '-o' ||
        arg === '-O' ||
        arg === '--output' ||
        arg.startsWith('--output=') ||
        arg.startsWith('--exec=') ||
        arg === '--exec',
    )
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The path-stripped, lowercased executable name of an argv, for set lookups. */
export function commandName(argv0: string | undefined): string {
  return basename(argv0 ?? '').toLowerCase()
}

/**
 * Drop leading environment assignments and pass-through wrappers until the argv
 * starts at the command that actually runs.
 */
export function unwrapWrappers(argv: readonly string[]): string[] {
  const current = [...argv]
  for (;;) {
    while (ASSIGNMENT.test(current[0] ?? '')) current.shift()
    const spec = PASS_THROUGH_WRAPPERS.get(commandName(current[0]))
    if (!spec) return current
    current.shift()
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
/** `>` truncates its target to zero length before writing; `>>` appends. */
const WRITE_REDIRECTS = new Set(['>', '>>'])

/**
 * Every redirect operator, write or read. The token after any of these names a
 * file or file descriptor, never a command, so it must not become a segment head:
 * `tee out.txt < src/in.txt` was reporting "script contents could not be
 * inspected safely: src/in.txt" because `src/in.txt` looked like a relative
 * executable.
 */
const REDIRECTS = new Set([...WRITE_REDIRECTS, '<', '<<', '<<<', '>&', '<&', '&>', '>|'])

export function shellSegments(command: string): string[][] {
  const segments: string[][] = []

  let tokens: ReturnType<typeof parseShellCommand> | null
  try {
    tokens = parseShellCommand(command)
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

  for (const segment of command.split(/&&|\|\||[;&|(\r\n]+/)) {
    const argv = withoutRawRedirects(rawTokens(segment))
    if (argv.length > 0) segments.push(argv)
  }

  return segments
}

export interface ShellRedirect {
  target: string
  /** True for `>` — the file's previous contents are gone whether or not the write succeeds. */
  truncates: boolean
}

/**
 * Files a command line opens for writing via redirection.
 *
 * A redirect is the plainest destructive verb the shell has and it has no command
 * name at all, so no argv-based inspector can see it: `echo "" > /etc/passwd`
 * erases the password file with nothing in argv but `echo`. `>&` (file-descriptor
 * duplication, as in `2>&1`) is deliberately excluded — it writes no file.
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
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (pending !== null) {
        redirects.push({ target: token, truncates: pending })
        pending = null
      }
      continue
    }
    if ('op' in token && token.op === 'glob') {
      if (pending !== null) {
        redirects.push({ target: token.pattern, truncates: pending })
        pending = null
      }
      continue
    }
    pending = 'op' in token && WRITE_REDIRECTS.has(token.op) ? token.op === '>' : null
  }
  return redirects
}
