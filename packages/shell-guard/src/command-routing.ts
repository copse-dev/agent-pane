import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import { parse as parseShell } from 'shell-quote'
import { isValidTrustedCommand } from './trusted-commands.ts'
import {
  CODE_INTERPRETERS,
  TRUST_TRANSPARENT_WRAPPERS,
  printfAssignsShellVariable,
  shellRedirects,
} from './shell-argv.ts'
import { analyzeShellCommand, dangerousInSandboxReasons } from './shell-scope.ts'

/**
 * Trusted-command routing — decide whether a shell command may run UNSANDBOXED
 * with no approval prompt because every part of it is either explicitly trusted
 * by the user or a trivially-safe preparation step.
 *
 * This is the "complete allow" lever: a narrow set of commands that cannot run
 * inside the workspace sandbox (host toolchain, code signing, vendor endpoints —
 * `xcodebuild` is the canonical example) but are safe for a trusted project, so
 * they should not interrupt the user on every invocation.
 *
 * SAFETY MODEL. This is a UX lever layered on the existing gate, not a new
 * boundary, and it is deliberately conservative — a command runs unsandboxed with
 * no prompt ONLY when ALL of the following hold:
 *
 *  - the command has no command substitution, subshell grouping, or backticks
 *    (they can hide arbitrary tools);
 *  - no segment redirects output into a file (other than `/dev/null`) — the
 *    shell opens that file itself, outside anything the trusted binary implies;
 *  - it triggers none of the destructive-in-sandbox patterns (`rm -rf`, fork
 *    bombs, pipe-to-interpreter, …) on the whole command;
 *  - EVERY top-level segment (split on `&&`/`||`/`;`/`|`/`&`) is either
 *      (a) an explicitly trusted command whose basename is in the allow-list, OR
 *      (b) a trivially-safe prep command (`mkdir`, `cd`, `echo`, …) that itself
 *          shows NO network/outside-workspace signals under {@link analyzeShellCommand},
 *          and whose `cd`/`mkdir` directory stays inside the workspace from every
 *          directory an earlier `cd` may have left the line in;
 *  - at least one segment is actually trusted (otherwise there is nothing that
 *    needs to escape the sandbox — it runs contained via the normal path);
 *  - no segment's head is an interpreter/shell that can execute arbitrary code
 *    (`sh`, `bash`, `node`, `python`, `ssh`, `sudo`, …) — allow-listing one of
 *    those would turn a single grant into an unbounded escape, so we refuse it.
 *
 * Crucially, the trust waiver applies ONLY to the specific trusted segment: a
 * sibling `curl`/`git push`/`npm test` segment is NOT trusted and NOT trivially
 * safe, so the whole command falls back to the normal gate (which sandboxes or
 * prompts). Unlike a "run the whole line at the most-permissive tier" rule, this
 * never runs a sandbox-dependent co-process (e.g. `npm test`) unsandboxed just
 * because a sibling is trusted.
 *
 * The resolver is PURE; the settings-backed wrapper (workspace-trust gating,
 * auto-run gating, caching) lives in `command-routing-config.ts`.
 */

export type CommandRouting =
  | { outcome: 'allow'; reasons: string[] }
  | { outcome: 'defer'; reasons: string[] }

/**
 * Commands trivially safe to run unsandboxed: they make directories, print, or
 * change directory and cannot exfiltrate or damage anything on their own. Any
 * argument that tries to escape the workspace (`mkdir ~/x`, `cp /etc/…`) is
 * caught by {@link analyzeShellCommand} returning a non-`sandbox` verdict, and a
 * `cd`/`mkdir` directory with no separator (`~`, `/`, `..`) by routing's own
 * resolution; either disqualifies the whole command — so this set only needs to
 * list heads whose *base* behaviour is harmless. Deliberately excludes `rm`, `cp`, `mv` and any
 * command whose safety depends on flags.
 */
export const SAFE_PREP_COMMANDS: ReadonlySet<string> = new Set([
  'mkdir',
  'cd',
  'pwd',
  'echo',
  'printf',
  'true',
  'false',
  ':',
  'basename',
  'dirname',
])

/**
 * Heads that must NEVER be honoured as trusted even if the user adds them:
 * interpreters, shells, and remote-exec tools run arbitrary code, so trusting
 * `bash` would let `bash -c '<anything>'` escape with no prompt — defeating the
 * point of a narrow allow-list. Listing one of these is treated as if it were
 * not on the list at all.
 *
 * The interpreter half comes from `shell-argv.ts` so this list cannot fall behind
 * the set the other analyzers treat as code-executing; the rest are tools that
 * are not interpreters but hand execution somewhere this gate cannot see.
 */
const NON_TRUSTABLE_COMMANDS: ReadonlySet<string> = new Set([
  ...CODE_INTERPRETERS,
  'fish',
  'csh',
  'tcsh',
  'php',
  'env',
  'eval',
  'exec',
  'command',
  'xargs',
  'find',
  'ssh',
  'scp',
  'sudo',
  'su',
  'doas',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'awk',
  'gawk',
])

// Leading tokens that wrap the real command without changing what runs. Narrower
// than the harm gate's wrapper list on purpose — see TRUST_TRANSPARENT_WRAPPERS.
const TRANSPARENT_PREFIXES = TRUST_TRANSPARENT_WRAPPERS

/**
 * Command substitution / subshell grouping / backticks can hide arbitrary tools
 * from segment analysis, so their mere presence disqualifies the fast path. The
 * check is intentionally over-broad (it does not exclude occurrences inside
 * single quotes) because a false positive only means "fall back to the normal
 * gate", never an unsafe auto-run.
 */
function hasGroupingOrSubstitution(command: string): boolean {
  // `$'…'` is refused with them: bash and zsh end it at the first unescaped
  // quote, a POSIX `sh` at the first quote of any kind, so the segment split
  // below cannot know where it closes. Read the POSIX way,
  // `trusted $'\'' ; curl … #'` is one trusted segment; bash runs the `curl`.
  return /[`(]|\$'/.test(command)
}

/**
 * Split a command line into top-level segments at the control operators
 * `&&`/`||`/`;`/`|`/`|&`/`&` (and newlines), honouring single/double quotes and
 * backslash escapes so an operator inside a string literal or an escaped `\;`
 * does not split. A lone `&` that is part of a redirect (`2>&1`, `&>file`) is
 * NOT treated as a control operator. Callers must have already rejected command
 * substitution / grouping via {@link hasGroupingOrSubstitution}.
 */
export type ShellControlOperator = '&&' | '||' | ';' | '|' | '|&' | '&'

export interface ShellComposition {
  segments: string[]
  operators: ShellControlOperator[]
}

export function scanShellComposition(command: string): ShellComposition | null {
  const segments: string[] = []
  const operators: ShellControlOperator[] = []
  let current = ''
  const state: { quote: '"' | "'" | null } = { quote: null }
  const split = (operator: ShellControlOperator): boolean => {
    const segment = current.trim()
    if (!segment) return false
    segments.push(segment)
    operators.push(operator)
    current = ''
    return true
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i)
    if (state.quote) {
      current += ch
      if (state.quote === '"' && ch === '\\' && i + 1 < command.length) {
        current += command.charAt(++i) // escaped char stays literal, cannot close the quote
      } else if (ch === state.quote) {
        state.quote = null
      }
      continue
    }
    if (ch === '\\') {
      current += ch
      if (i + 1 < command.length) current += command.charAt(++i)
      continue
    }
    if (ch === '"' || ch === "'") {
      state.quote = ch
      current += ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '|&') {
      if (!split(two)) return null
      i++
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|') {
      if (!split(ch === '\n' ? ';' : ch)) return null
      continue
    }
    if (ch === '&') {
      // `>&`/`&>` are redirects, not control operators — keep them in the segment.
      if (command.charAt(i - 1) === '>' || command.charAt(i + 1) === '>') {
        current += ch
        continue
      }
      if (!split('&')) return null
      continue
    }
    current += ch
  }
  if (state.quote !== null) return null
  const finalSegment = current.trim()
  if (finalSegment) segments.push(finalSegment)
  if (segments.length === 0 || operators.length !== segments.length - 1) return null
  return { segments, operators }
}

export function splitSegments(command: string): string[] {
  return scanShellComposition(command)?.segments ?? []
}

/**
 * Parse only the top-level composition needed by security policy. This is not a
 * general shell AST: substitutions and grouping fail closed, while words remain
 * byte-for-byte source segments for exact authorization checks.
 */
export function parseShellComposition(command: string): ShellComposition | null {
  if (hasGroupingOrSubstitution(command)) return null
  try {
    parseShell(command)
  } catch {
    return null
  }
  return scanShellComposition(command)
}

/**
 * Extract the command head (basename) of a segment via shell-quote's tokenizer
 * (quote-aware), skipping `VAR=val` assignments and transparent wrappers. Returns
 * null when no plain command word can be found (e.g. a leading operator token).
 */
export function commandHead(segment: string): string | null {
  let tokens: ReturnType<typeof parseShell>
  try {
    tokens = parseShell(segment)
  } catch {
    return null
  }
  for (const token of tokens) {
    if (typeof token !== 'string') return null // an operator/glob before any command word
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue // environment assignment
    const base = token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token
    if (TRANSPARENT_PREFIXES.has(base)) continue
    return base || null
  }
  return null
}

/**
 * The name of the first `NAME=value` assignment ahead of a segment's command
 * word, or null when there is none. A per-command environment changes what the
 * named binary runs or loads while its head still reads as the trusted name, so
 * routing refuses it — the rule auto-approval already applies in `effectiveArgv`.
 */
function leadingAssignment(segment: string): string | null {
  let tokens: ReturnType<typeof parseShell>
  try {
    tokens = parseShell(segment)
  } catch {
    return null
  }
  for (const token of tokens) {
    if (typeof token !== 'string') return null
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token)
    if (assignment) return assignment[1] ?? null
    const base = token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token
    if (!TRANSPARENT_PREFIXES.has(base)) return null
  }
  return null
}

/** The argv beginning at the command word, using routing's narrow wrapper set. */
function routingArgv(segment: string): string[] | null {
  let tokens: ReturnType<typeof parseShell>
  try {
    tokens = parseShell(segment)
  } catch {
    return null
  }
  if (!tokens.every((token) => typeof token === 'string')) return null
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++
      continue
    }
    const base = token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token
    if (TRANSPARENT_PREFIXES.has(base)) {
      index++
      continue
    }
    break
  }
  return tokens.slice(index)
}

/** Prep commands whose operands name directories, which routing resolves itself. */
const DIRECTORY_PREP_COMMANDS: ReadonlySet<string> = new Set(['cd', 'mkdir'])

/** Any root gives the same answer for a relative path; this one stands in when none is known. */
const STAND_IN_ROOT = resolve('/workspace')

/** More possible working directories than this and routing stops tracking them. */
const MAX_TRACKED_DIRECTORIES = 32

/** The one directory a `cd` names, or null for `cd` alone (home), `cd -` (`$OLDPWD`) and two operands. */
function cdOperands(args: readonly string[]): string[] | null {
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ''
    if (arg === '--') {
      index++
      break
    }
    if (arg === '-' || !arg.startsWith('-')) break
    index++
  }
  const operands = args.slice(index)
  if (operands.length !== 1 || operands[0] === '-') return null
  return operands
}

/** The directories a `mkdir` creates; `-m`/`--mode` take the next word as their value. */
function mkdirOperands(args: readonly string[]): string[] {
  const operands: string[] = []
  let options = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (/^-[^-]*m$/.test(arg) || arg === '--mode') index++
      continue
    }
    operands.push(arg)
  }
  return operands
}

/**
 * Where a directory word lands from `cwd`, or null when this gate cannot say:
 * `~user`, `~+` and `~-` name directories it does not know, and with no
 * workspace root an absolute or home path has nothing to be compared against.
 */
function resolveDirectory(word: string, cwd: string, root: string | null): string | null {
  if (word === '') return null
  if (word.startsWith('~')) {
    if (word !== '~' && !word.startsWith('~/')) return null
    return root === null ? null : resolve(homedir(), `.${word.slice(1)}`)
  }
  if (isAbsolute(word)) return root === null ? null : resolve(word)
  return resolve(cwd, word)
}

/**
 * The working directories the line may be in after a `cd` or `mkdir` prep step,
 * or null when the step names, or may run from, a directory outside the
 * workspace.
 *
 * The scope analyzer keys its outside-path rules on a separator, so a bare `~`,
 * `/` or `..` scored `sandbox`, and `cd ~ && xcodebuild build` ran the trusted
 * command in the home directory, unsandboxed, with no prompt. The analyzer's
 * verdict is a containment answer and the OS sandbox refuses those reads, so
 * routing — which runs the whole line outside it — resolves the words itself.
 *
 * Each candidate directory is a place the step may run from. In a line joined
 * only by `&&` a step runs only after every earlier `cd` succeeded, so the
 * directory is known; any other operator can skip a `cd` or run it in a
 * subshell, so both outcomes stay candidates (`cd ios; cd ..` may climb out of
 * the workspace when `ios` is missing). A word an expansion decides (`$OLDPWD`,
 * `{..,x}`) is not resolved.
 */
function directoriesAfterPrep(
  head: string,
  argv: readonly string[],
  segment: string,
  cwds: ReadonlySet<string>,
  root: string | null,
  sequential: boolean,
): ReadonlySet<string> | null {
  if (/[$`{}]/.test(segment)) return null
  const operands = head === 'cd' ? cdOperands(argv.slice(1)) : mkdirOperands(argv.slice(1))
  if (operands === null) return null
  const base = root ?? STAND_IN_ROOT
  const prefix = base.endsWith(sep) ? base : base + sep
  const reached = new Set<string>()
  for (const cwd of cwds) {
    for (const operand of operands) {
      const target = resolveDirectory(operand, cwd, root)
      if (target === null || (target !== base && !target.startsWith(prefix))) return null
      reached.add(target)
    }
  }
  if (head !== 'cd') return cwds
  const next = sequential ? reached : new Set([...cwds, ...reached])
  return next.size > MAX_TRACKED_DIRECTORIES ? null : next
}

/**
 * Resolve whether {@link command} may run unsandboxed with no prompt.
 *
 * @param trusted allow-listed command basenames (already validated).
 */
export function resolveCommandRouting(
  command: string,
  workspaceRoot: string | null,
  trusted: ReadonlySet<string>,
): CommandRouting {
  const trimmed = command.trim()
  if (!trimmed) return { outcome: 'defer', reasons: ['empty command'] }
  if (trusted.size === 0) return { outcome: 'defer', reasons: ['no trusted commands configured'] }

  if (hasGroupingOrSubstitution(trimmed)) {
    return { outcome: 'defer', reasons: ['command substitution or subshell present'] }
  }
  if (dangerousInSandboxReasons(trimmed).length > 0) {
    return { outcome: 'defer', reasons: ['destructive pattern present'] }
  }

  const composition = scanShellComposition(trimmed)
  const sequential = composition?.operators.every((operator) => operator === '&&') ?? true
  const root = workspaceRoot === null ? null : resolve(workspaceRoot)
  let cwds: ReadonlySet<string> = new Set([root ?? STAND_IN_ROOT])
  let anyTrusted = false
  for (const segment of composition?.segments ?? []) {
    // The whole line runs unsandboxed once routed, so this applies to prep
    // segments as well as the trusted one.
    const assignment = leadingAssignment(segment)
    if (assignment) {
      return {
        outcome: 'defer',
        reasons: [`environment assignment before the command: ${assignment}`],
      }
    }
    // The shell, not the trusted binary, opens a redirect target, and once routed
    // it does so unsandboxed: `xcodebuild -version >> ~/.ssh/authorized_keys`
    // would append to any file. Only discarding output is let through.
    const written = shellRedirects(segment).find((redirect) => redirect.target !== '/dev/null')
    if (written) {
      return { outcome: 'defer', reasons: [`redirect writes to ${written.target}`] }
    }
    const head = commandHead(segment)
    if (head && trusted.has(head) && !NON_TRUSTABLE_COMMANDS.has(head)) {
      anyTrusted = true
      continue
    }
    // Not trusted → must be a trivially-safe prep command with no escape signals.
    if (!head || !SAFE_PREP_COMMANDS.has(head)) {
      return { outcome: 'defer', reasons: [`segment not trusted: ${head ?? segment}`] }
    }
    const prepArgv = routingArgv(segment)
    if (!prepArgv || printfAssignsShellVariable(prepArgv)) {
      return { outcome: 'defer', reasons: ['printf -v assigns a shell variable'] }
    }
    if (analyzeShellCommand(segment, workspaceRoot).verdict !== 'sandbox') {
      return { outcome: 'defer', reasons: [`prep command shows escape signals: ${segment}`] }
    }
    if (dangerousInSandboxReasons(segment).length > 0) {
      return { outcome: 'defer', reasons: [`prep command is destructive: ${segment}`] }
    }
    if (DIRECTORY_PREP_COMMANDS.has(head)) {
      const next = directoriesAfterPrep(head, prepArgv, segment, cwds, root, sequential)
      if (!next) {
        return { outcome: 'defer', reasons: [`prep step leaves the workspace: ${segment}`] }
      }
      cwds = next
    }
  }

  if (!anyTrusted) {
    // Nothing here needs to escape the sandbox — let the normal path run it contained.
    return { outcome: 'defer', reasons: ['no trusted command in a fully-safe command line'] }
  }
  return { outcome: 'allow', reasons: ['all segments trusted or trivially safe'] }
}

/**
 * The single binary an escalation prompt may offer to add to the trusted
 * allow-list (via an "always allow" tick box), or null when this command is not
 * eligible to be remembered as trusted.
 *
 * Eligible ONLY for a single simple command — no pipeline, `&&`/`||`/`;`, command
 * substitution, or subshell — whose head resolves to a concrete binary that is
 * not an interpreter/shell ({@link NON_TRUSTABLE_COMMANDS}), not a trivially-safe
 * prep command (nothing to trust — those never need to escape), not destructive,
 * and is a valid bare command name. Restricting the offer to one unambiguous
 * binary is what makes remembering safe: the grant the user approves ("always
 * allow xcodebuild") is exactly the basename stored, and every FUTURE use of it
 * still passes through {@link resolveCommandRouting}'s per-segment analysis — so a
 * later `xcodebuild && curl evil` is NOT laundered by the grant, it defers to the
 * normal gate like any untrusted compound.
 */
export function trustableCommandHead(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (hasGroupingOrSubstitution(trimmed)) return null
  if (dangerousInSandboxReasons(trimmed).length > 0) return null

  const segments = splitSegments(trimmed)
  if (segments.length !== 1) return null

  const head = commandHead(segments[0] ?? '')
  if (!head) return null
  if (NON_TRUSTABLE_COMMANDS.has(head)) return null
  if (SAFE_PREP_COMMANDS.has(head)) return null
  if (!isValidTrustedCommand(head)) return null
  return head
}
