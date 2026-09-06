/**
 * Say why a sandboxed `run_shell` command was denied, in words the model can act
 * on (issue #1714).
 *
 * The failure this exists for: the shell runs in the thread's execution root,
 * the model `cd`s to the path it believes is the workspace root, and lands
 * outside the sandbox. `cd` itself reports success — it is the commands *after*
 * it that fail, with `Operation not permitted` and, from git, `fatal: Unable to
 * read current working directory`. Neither names a path or mentions a policy, so
 * the trace reads as a broken checkout rather than a denial, and the model spends
 * turns re-deriving the layout instead of dropping the `cd`.
 *
 * SECURITY: everything here is advisory text. It is derived from the
 * model-authored command string and from runner-side violation counts — never
 * from the command's own stdout/stderr, and it never feeds an authorization
 * decision. Keying an escape hatch off output would re-open issue #104, where a
 * command that echoes "operation not permitted" could socially-engineer the user
 * into approving an unsandboxed re-run. `detectSandboxFailure` remains the only
 * thing that decides whether an unsandboxed retry may be offered.
 */

import { isAbsolute, normalize, relative, resolve } from 'node:path'

/** Shell operators that end one simple command and begin the next. */
const COMMAND_SEPARATORS = /\|\||&&|[;\n|&]/

/**
 * macOS exposes `/var`, `/tmp` and `/etc` as symlinks into `/private`, so the
 * same directory has two spellings and a naive prefix test calls one "outside"
 * the other. Stripping the prefix from *both* sides preserves the containment
 * relation wherever it is not an alias, so a non-macOS path that genuinely lives
 * under `/private` is compared unchanged against a root that does too. A wrong
 * answer here costs at most a missing hint — never an access decision.
 */
function stripPrivateAlias(path: string): string {
  return path.startsWith('/private/') ? path.slice('/private'.length) : path
}

/** Whether `target` resolves outside `root`. Pure path arithmetic; touches no disk. */
export function isPathOutsideRoot(root: string, target: string): boolean {
  const rel = relative(stripPrivateAlias(normalize(root)), stripPrivateAlias(normalize(target)))
  return rel.startsWith('..') || isAbsolute(rel)
}

function unquote(value: string): string {
  const first = value[0]
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length > 1) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * The directory a leading `cd` in `command` moves to, when that lands outside
 * `root`; otherwise null.
 *
 * Deliberately narrow. Only `cd` is parsed — scraping every path-shaped token out
 * of a shell command produces false positives (flag values, URLs, strings) and
 * this text is shown to a model that will act on it. A quoted `&&` inside an
 * argument can end a segment early, which loses the hint rather than inventing
 * one; the generic violation-count branch still covers those runs.
 */
export function cdTargetOutsideRoot(command: string, root: string, home?: string): string | null {
  for (const rawSegment of command.split(COMMAND_SEPARATORS)) {
    const segment = rawSegment.trim()
    const match = /^cd\s+(\S.*)$/.exec(segment)
    if (!match?.[1]) continue
    // Only the directory operand; `cd foo bar` is an error anyway, and a trailing
    // redirect is not part of the path.
    const operand = unquote(match[1].trim().split(/\s+/)[0] ?? '')
    // `cd`, `cd -`, `cd --`, `cd ~-`: no literal destination to reason about.
    if (!operand || operand.startsWith('-')) continue
    let target = operand
    if (home && (target === '~' || target.startsWith('~/'))) {
      target = target === '~' ? home : resolve(home, target.slice(2))
    }
    if (target.startsWith('$')) continue // unexpanded variable; nothing to name
    const absolute = isAbsolute(target) ? normalize(target) : resolve(root, target)
    if (isPathOutsideRoot(root, absolute)) return absolute
  }
  return null
}

export interface SandboxDenialAdviceInput {
  /** The directory `run_shell` actually executed in. */
  root: string
  /** Result of {@link cdTargetOutsideRoot} for this command. */
  cdTarget: string | null
  /** Sandbox policy violations the *runner* recorded for this command. */
  blockedOperations: number
}

/**
 * A sentence to append to a failed sandboxed run, or null when nothing about the
 * failure points at the sandbox — an ordinary non-zero exit (a failing test, a
 * compile error) must read as itself, not as a policy problem.
 */
export function sandboxDenialAdvice({
  root,
  cdTarget,
  blockedOperations,
}: SandboxDenialAdviceInput): string | null {
  if (cdTarget !== null) {
    return (
      `run_shell runs in ${root}. This command changed directory to ${cdTarget}, which is ` +
      'outside it. `cd` reports success even when the sandbox will not let anything read the ' +
      'target, so the commands after it fail with "Operation not permitted" (git reports it as ' +
      '"Unable to read current working directory"). Drop the `cd` and use paths relative to ' +
      `${root}, which is the same checkout.`
    )
  }
  if (blockedOperations > 0) {
    const operations =
      blockedOperations === 1 ? '1 operation' : `${String(blockedOperations)} operations`
    return (
      `The OS sandbox blocked ${operations} this command attempted. run_shell runs in ${root}; ` +
      'paths outside it, and the network, are not reachable from inside the sandbox.'
    )
  }
  return null
}

/**
 * Why an unsandboxed retry was not offered for a failure that looks sandbox-shaped.
 *
 * #1714 could not tell which of the two predicates declined without instrumenting
 * the build, so the answer is recorded rather than reconstructed. Only emitted
 * when the command actually named a path outside the root — otherwise every
 * failing test run inside the sandbox would write a line.
 */
export const RETRY_WITHHELD_REASONS = {
  notEligible:
    'unsandboxed retry not offered: the command is classified as already running outside the ' +
    'sandbox, with no filesystem-escape reason (shellSandboxFailureShouldOfferUnsandboxedRetry)',
  noRunnerEvidence:
    'unsandboxed retry not offered: the command named a path outside the execution root, but the ' +
    'runner recorded no sandbox violation for it (detectSandboxFailure)',
} as const
