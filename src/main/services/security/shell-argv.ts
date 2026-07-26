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
}

/**
 * Commands that execute their tail unchanged. Looking through them is always
 * correct for *analysis*: `timeout 5 rm -rf ~` deletes the home directory just
 * as `rm -rf ~` does, and a gate that only sees `timeout` sees nothing.
 */
export const PASS_THROUGH_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
  ['env', { assignments: true }],
  ['timeout', { numeric: true }],
  ['stdbuf', { numeric: true }],
  ['xargs', {}],
  ['time', {}],
  ['nice', {}],
  ['ionice', {}],
  ['command', {}],
  ['builtin', {}],
  ['nohup', {}],
  ['sudo', {}],
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
    const flush = (): void => {
      if (current.length > 0) segments.push(current)
      current = []
    }
    for (const token of tokens) {
      if (typeof token === 'string') {
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
      flush()
    }
    flush()
  }

  for (const segment of command.split(/&&|\|\||[;&|(\r\n]+/)) {
    const argv = rawTokens(segment)
    if (argv.length > 0) segments.push(argv)
  }

  return segments
}
