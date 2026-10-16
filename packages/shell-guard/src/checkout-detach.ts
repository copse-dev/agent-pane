import {
  SHELL_INTERPRETERS,
  commandName,
  inlineCodeBody,
  shellSegments,
  unwrapWrappers,
} from './shell-argv.ts'

/**
 * A Git command that leaves a checkout without a branch, or part-way through
 * an operation that only a person at a terminal can finish: a rebase that stops
 * on a conflict or a failed signature, a bisect, a detached switch. A thread's
 * isolated worktree is bound to its branch, so any of these strands the thread
 * until someone recovers it.
 */
export interface CheckoutDetachingCommand {
  /** Short name for the refused operation, e.g. `git rebase`. */
  operation: string
  /** What to do instead, addressed to the agent. */
  advice: string
}

const REBASE_EXITS: ReadonlySet<string> = new Set([
  '--abort',
  '--continue',
  '--skip',
  '--quit',
  '--edit-todo',
  '--show-current-patch',
])

const ASK_USER = 'If it is genuinely needed, stop and ask the user to run it in a terminal.'

function gitInvocation(
  argv: readonly string[],
): { subcommand: string; args: string[]; config: string[] } | null {
  const unwrapped = unwrapWrappers(argv)
  if (commandName(unwrapped[0]) !== 'git') return null
  const config: string[] = []
  const rest = unwrapped.slice(1)
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] ?? ''
    if (token === '-c') {
      config.push((rest[index + 1] ?? '').toLowerCase())
      index++
      continue
    }
    if (
      token === '-C' ||
      token === '--git-dir' ||
      token === '--work-tree' ||
      token === '--namespace'
    ) {
      index++
      continue
    }
    if (token.startsWith('-')) continue
    return { subcommand: token, args: rest.slice(index + 1), config }
  }
  return null
}

/**
 * Whether a `pull.rebase` / `--rebase=<value>` value makes `git pull` rebase.
 * Git reads it as a boolean (`true|yes|on`, a non-zero integer) or one of the
 * rebase modes; a bare key is true, and anything else is an error that stops
 * before any rebase starts.
 */
function rebaseValueRebases(value: string | undefined): boolean {
  if (value === undefined) return true
  const normalized = value.toLowerCase()
  if (['merges', 'm', 'interactive', 'i', 'true', 'yes', 'on'].includes(normalized)) return true
  return /^-?\d+$/.test(normalized) && Number(normalized) !== 0
}

/**
 * Last setting wins, as in Git: `-c pull.rebase=…` entries first (they precede
 * the subcommand), then the pull's own flags, which override config.
 */
function pullRebases(args: readonly string[], config: readonly string[]): boolean {
  let rebases = false
  for (const entry of config) {
    const equals = entry.indexOf('=')
    const key = equals === -1 ? entry : entry.slice(0, equals)
    if (key !== 'pull.rebase') continue
    rebases = rebaseValueRebases(equals === -1 ? undefined : entry.slice(equals + 1))
  }
  for (const arg of args) {
    if (arg === '--no-rebase') rebases = false
    else if (arg === '-r' || arg === '--rebase') rebases = true
    else if (arg.startsWith('--rebase='))
      rebases = rebaseValueRebases(arg.slice('--rebase='.length))
  }
  return rebases
}

function classify(argv: readonly string[]): CheckoutDetachingCommand | null {
  const invocation = gitInvocation(argv)
  if (!invocation) return null
  const { subcommand, args, config } = invocation
  const positional = args.find((arg) => !arg.startsWith('-'))

  if (subcommand === 'rebase') {
    if (args.some((arg) => REBASE_EXITS.has(arg))) return null
    return {
      operation: 'git rebase',
      advice: `A rebase that stops on a conflict or a signing failure leaves this checkout detached. Bring in upstream work with \`git merge <branch>\` instead. ${ASK_USER}`,
    }
  }
  if (subcommand === 'pull' && pullRebases(args, config)) {
    return {
      operation: 'git pull --rebase',
      advice: `A rebasing pull that stops leaves this checkout detached. Use \`git pull --no-rebase\` (or \`git fetch\` then \`git merge\`). ${ASK_USER}`,
    }
  }
  if (subcommand === 'bisect' && positional === 'start') {
    return {
      operation: 'git bisect start',
      advice: `Bisecting detaches HEAD and would strand this thread's checkout. Find the culprit with \`git log\`, \`git show\` and \`git diff\`, or \`git worktree add --detach\` outside this checkout. ${ASK_USER}`,
    }
  }
  if (
    (subcommand === 'switch' && args.some((arg) => arg === '--detach' || arg === '-d')) ||
    (subcommand === 'checkout' && args.includes('--detach'))
  ) {
    return {
      operation: `git ${subcommand} --detach`,
      advice: `Detaching HEAD would strand this thread's checkout. Inspect a commit with \`git show <commit>\` or \`git worktree add --detach <path> <commit>\` outside this checkout.`,
    }
  }
  return null
}

/**
 * The first command in `command` that would detach the checkout it runs in, or
 * null. Exits from an operation already under way (`rebase --abort`,
 * `bisect reset`, `--continue`) are never reported: they are how a stranded
 * checkout gets back.
 */
export function detectCheckoutDetachingCommand(command: string): CheckoutDetachingCommand | null {
  for (const segment of shellSegments(command)) {
    const found = classify(segment)
    if (found) return found
    // `sh -c 'git rebase main'`: the segment is the interpreter, the command is its body.
    const unwrapped = unwrapWrappers(segment)
    if (SHELL_INTERPRETERS.has(commandName(unwrapped[0]))) {
      const body = inlineCodeBody(unwrapped)
      const nested = body === null ? null : detectCheckoutDetachingCommand(body)
      if (nested) return nested
    }
  }
  return null
}
