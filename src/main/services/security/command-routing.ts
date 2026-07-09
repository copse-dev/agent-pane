import { parse as parseShell } from 'shell-quote'
import { isValidTrustedCommand } from '@shared/command-routing.ts'
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
 *  - it triggers none of the destructive-in-sandbox patterns (`rm -rf`, fork
 *    bombs, pipe-to-interpreter, …) on the whole command;
 *  - EVERY top-level segment (split on `&&`/`||`/`;`/`|`/`&`) is either
 *      (a) an explicitly trusted command whose basename is in the allow-list, OR
 *      (b) a trivially-safe prep command (`mkdir`, `cd`, `echo`, …) that itself
 *          shows NO network/outside-workspace signals under {@link analyzeShellCommand};
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
 * caught by {@link analyzeShellCommand} returning a non-`sandbox` verdict, which
 * disqualifies the whole command — so this set only needs to list heads whose
 * *base* behaviour is harmless. Deliberately excludes `rm`, `cp`, `mv` and any
 * command whose safety depends on flags.
 */
const SAFE_PREP_COMMANDS = new Set([
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
 */
const NON_TRUSTABLE_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'env',
  'eval',
  'exec',
  'command',
  'xargs',
  'find',
  'node',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'php',
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
]) satisfies Set<string>

// Leading tokens that wrap the real command without changing what runs.
const TRANSPARENT_PREFIXES = new Set(['nohup', 'nice', 'stdbuf', 'time', 'builtin'])

/**
 * Command substitution / subshell grouping / backticks can hide arbitrary tools
 * from segment analysis, so their mere presence disqualifies the fast path. The
 * check is intentionally over-broad (it does not exclude occurrences inside
 * single quotes) because a false positive only means "fall back to the normal
 * gate", never an unsafe auto-run.
 */
function hasGroupingOrSubstitution(command: string): boolean {
  return /[`(]/.test(command)
}

/**
 * Split a command line into top-level segments at the control operators
 * `&&`/`||`/`;`/`|`/`&` (and newlines), honouring single/double quotes and
 * backslash escapes so an operator inside a string literal or an escaped `\;`
 * does not split. A lone `&` that is part of a redirect (`2>&1`, `&>file`) is
 * NOT treated as a control operator. Callers must have already rejected command
 * substitution / grouping via {@link hasGroupingOrSubstitution}.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i)
    if (quote) {
      current += ch
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        current += command.charAt(++i) // escaped char stays literal, cannot close the quote
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '\\') {
      current += ch
      if (i + 1 < command.length) current += command.charAt(++i)
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      segments.push(current)
      current = ''
      i++
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|') {
      segments.push(current)
      current = ''
      continue
    }
    if (ch === '&') {
      // `>&`/`&>` are redirects, not control operators — keep them in the segment.
      if (command.charAt(i - 1) === '>' || command.charAt(i + 1) === '>') {
        current += ch
        continue
      }
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments.map((s) => s.trim()).filter(Boolean)
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

  let anyTrusted = false
  for (const segment of splitSegments(trimmed)) {
    const head = commandHead(segment)
    if (head && trusted.has(head) && !NON_TRUSTABLE_COMMANDS.has(head)) {
      anyTrusted = true
      continue
    }
    // Not trusted → must be a trivially-safe prep command with no escape signals.
    if (!head || !SAFE_PREP_COMMANDS.has(head)) {
      return { outcome: 'defer', reasons: [`segment not trusted: ${head ?? segment}`] }
    }
    if (analyzeShellCommand(segment, workspaceRoot).verdict !== 'sandbox') {
      return { outcome: 'defer', reasons: [`prep command shows escape signals: ${segment}`] }
    }
    if (dangerousInSandboxReasons(segment).length > 0) {
      return { outcome: 'defer', reasons: [`prep command is destructive: ${segment}`] }
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
