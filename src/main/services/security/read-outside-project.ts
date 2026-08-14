import { homedir } from 'node:os'
import { isAbsolute, basename, resolve, sep } from 'node:path'
import {
  commandName,
  shellRedirects,
  shellSegments,
  TRUST_TRANSPARENT_WRAPPERS,
  unwrapWrappers,
} from './shell-argv.ts'
import {
  dangerousInSandboxReasons,
  externalOnlyForOutsidePath,
  needsMoreThanOutsideAccess,
} from './shell-scope.ts'
import {
  READ_ONLY_GIT_SUBCOMMANDS,
  READ_ONLY_SHELL_BASENAMES,
  type ShellPromptParts,
} from './permission-policy.ts'

/**
 * Recognise the narrow shape "this command only READS files outside the project,
 * and we can say exactly which ones".
 *
 * The permission gate already asks about every command that escapes the project.
 * That prompt has to assume the worst — an escaping command may write, install,
 * or reach the network — so it is worded as a one-shot escape hatch. But a large
 * share of real escapes are a `cat`/`ls`/`grep` over a config file in the user's
 * home directory, where the blast radius is "the agent saw a file". Asking again
 * for every one of those is the prompt fatigue that trains users to click
 * Approve without reading.
 *
 * When a command matches the shape below, the gate offers a thread-scoped
 * "read outside the project" grant instead (see `read-outside-grant.ts`). The
 * grant is only ever *consulted* through this same analysis, so it authorises
 * nothing but more commands of the same shape: every later command must pass
 * these checks again on its own merits.
 *
 * SAFETY MODEL. This is an allow-list of shapes, not a denylist of dangers, and
 * it fails closed — one unrecognised head, flag, redirect, expansion, or
 * unresolvable path makes the whole line ineligible and it prompts exactly as it
 * does today. It can never turn a `deny` into an `allow`: the gate consults it
 * only after policy has already resolved to `prompt`.
 *
 * WHAT THE ALLOW-LIST IS FOR. Where a seatbelt exists, it — not this module —
 * is what stops an approved command writing or reaching the network
 * (`readAllowedSandboxOverlay` widens `allowRead` and nothing else). So the
 * shape checks are not the enforcement; they are the judgement about *when we
 * believe a read-shaped hole can be poked in the sandbox safely*, and about
 * whether "the agent wants to read X" is an honest description of what the user
 * is approving. That is why they stay even under containment: a contained
 * `rm ~/notes/todo.md` is harmless — the seatbelt refuses the unlink — but
 * describing it to the user as a read, and covering it with a standing read
 * grant, would not be.
 *
 * WHAT IT DOES NOT PROTECT AGAINST. Eligibility is decided from the command
 * text alone, so a recursive read of a directory the user granted can still
 * traverse into a file this module would have refused as a direct target
 * ({@link sensitiveTargetReason}). The whole home directory and the filesystem
 * root are therefore refused outright as targets, but a granted read of a
 * narrower directory is a real (bounded) trust decision, which is what the
 * prompt's warning says.
 */

/** Read-only heads beyond {@link READ_ONLY_SHELL_BASENAMES} that this shape allows. */
const EXTRA_READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  // Produce output from their arguments; touch no file at all.
  'echo',
  'printf',
  // Read-only inspectors that the generic list omits.
  'find',
  'readlink',
  'diff',
  'cmp',
  'git',
])

/**
 * Flags that turn an otherwise read-only command into one that writes a file or
 * runs another program. Checked per head, because the same spelling is harmless
 * elsewhere (`grep -o` prints matches; `sort -o` overwrites a file).
 */
const WRITING_FLAGS: ReadonlyMap<string, RegExp> = new Map([
  ['find', /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls|fprint0)$/],
  ['fd', /^(?:-x|-X|--exec|--exec-batch)$/],
  ['rg', /^--pre(?:=|$)/],
  ['sort', /^(?:-o|--output)(?:=|$)/],
  ['tree', /^(?:-o|--output)(?:=|$)/],
  ['git', /^(?:-o|-O|--output|--exec)(?:=|$)/],
])

/** Basenames whose contents are credentials by convention. */
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  'shadow',
  'master.key',
  'secring.gpg',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  // `.env`, `.env.local`, `.env.production`, `.env*` …
  /^\.env(?:[.*]|$)/i,
  // Private keys and keystores in any of their usual suffixes.
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc)$/i,
  /^id_[a-z0-9]+$/i,
  /(?:^|[.\-_])secrets?(?:[.\-_]|$)/i,
  /(?:^|[.\-_])credentials?(?:[.\-_]|$)/i,
]

/** Directory names that hold credentials for a whole toolchain. */
const SENSITIVE_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.password-store',
  '.kube',
  '.docker',
  '.chef',
  'keychains',
  'gcloud',
])

/** Whole-path fragments where only the pairing is sensitive (`.config/gh` holds a token). */
const SENSITIVE_PATH_FRAGMENTS: readonly string[] = ['/.config/gh/', '/.config/gcloud/']

export interface ReadOutsideProjectAnalysis {
  /** True when the command is a read this module can fully account for. */
  eligible: boolean
  /** The out-of-project paths it reads, as written by the agent (for prompt copy). */
  targets: string[]
  /**
   * The same paths, absolute and resolved — what a seatbelt rule has to name.
   * Index-aligned with {@link targets}, which stays as-written for prompt copy.
   */
  resolvedTargets: string[]
  /** Why it is not eligible; empty when it is. */
  blockers: string[]
}

interface AnalyzeOptions {
  /** Overridable for tests, which must not depend on the runner's real home. */
  homeDir?: string
}

const INELIGIBLE = (blockers: string[]): ReadOutsideProjectAnalysis => ({
  eligible: false,
  targets: [],
  resolvedTargets: [],
  blockers,
})

/**
 * Any `$VAR` other than `$HOME`, plus `$(…)` / backtick substitution. The value
 * of an unknown variable is invisible here, so a path built from one cannot be
 * classified as inside or outside the project.
 */
function expansionBlocker(command: string): string | null {
  if (/\$\(|`/.test(command)) return 'command substitution hides what is read'
  for (const match of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    if (match[1] !== 'HOME') return `variable expansion ($${match[1] ?? ''}) hides what is read`
  }
  return null
}

/** Expand a leading `~` / `$HOME` and resolve against the project root. */
function resolveTarget(token: string, workspaceRoot: string, homeDir: string): string {
  let path = token
  if (path === '~' || path.startsWith(`~${sep}`) || path.startsWith('~/')) {
    path = homeDir + path.slice(1)
  } else if (/^\$\{?HOME\}?(?:$|\/)/.test(path)) {
    path = homeDir + path.replace(/^\$\{?HOME\}?/, '')
  }
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path)
}

function looksLikePath(token: string): boolean {
  if (token === '~' || token === '..' || token === '.') return true
  if (token.startsWith('~') || token.startsWith('/') || token.startsWith('$HOME')) return true
  if (token.startsWith('${HOME}')) return true
  return token.includes('/')
}

function isInsideProject(resolved: string, workspaceRoot: string): boolean {
  return resolved === workspaceRoot || resolved.startsWith(workspaceRoot + sep)
}

/**
 * Why this target must never be covered by a blanket grant, or null when it is
 * an ordinary file. Both the token as written and its resolved path are tested,
 * so a glob (`~/.env*`) is caught even though it names no single file.
 */
export function sensitiveTargetReason(token: string, resolved: string): string | null {
  const lowerResolved = resolved.toLowerCase()
  for (const fragment of SENSITIVE_PATH_FRAGMENTS) {
    if (lowerResolved.includes(fragment)) return `credential store (${token})`
  }
  for (const segment of lowerResolved.split(sep)) {
    if (SENSITIVE_DIR_SEGMENTS.has(segment)) return `credential directory (${token})`
  }
  for (const name of [basename(token), basename(resolved)]) {
    const lower = name.toLowerCase()
    if (SENSITIVE_BASENAMES.has(lower)) return `credential file (${token})`
    if (SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(lower))) {
      return `credential file (${token})`
    }
  }
  return null
}

/**
 * Targets so broad that granting them is indistinguishable from granting the
 * whole machine: the home directory itself, the filesystem root, and any
 * ancestor of home. A narrower directory under home stays eligible.
 */
function breadthBlocker(token: string, resolved: string, homeDir: string): string | null {
  if (resolved === sep) return `the whole filesystem (${token})`
  if (resolved === homeDir) return `the whole home directory (${token})`
  if (homeDir.startsWith(resolved + sep)) return `a parent of the home directory (${token})`
  return null
}

/**
 * Why the command this segment runs is not a plain read, or null when it is.
 *
 * `rawArgv` matters as much as the unwrapped one: {@link unwrapWrappers} looks
 * through `sudo`, `env`, and `xargs` because seeing *deeper* is what harm
 * analysis wants, but eligibility here is a grant, so a wrapper that confers
 * privilege or rewrites the environment must disqualify the line rather than
 * disappear from it. Only the wrappers that change nothing about what runs
 * ({@link TRUST_TRANSPARENT_WRAPPERS}) may be looked through.
 */
function headBlocker(rawArgv: readonly string[], argv: readonly string[]): string | null {
  const rawHead = commandName(rawArgv[0])
  const head = commandName(argv[0])
  if (!head) return null
  if (rawHead !== head && !TRUST_TRANSPARENT_WRAPPERS.has(rawHead)) {
    return `runs through \`${rawHead}\`, which changes how the command runs`
  }
  if (!READ_ONLY_SHELL_BASENAMES.has(head) && !EXTRA_READ_ONLY_HEADS.has(head)) {
    return `runs \`${head}\`, which is not a plain read`
  }
  if (head === 'git' && !READ_ONLY_GIT_SUBCOMMANDS.has(argv[1] ?? '')) {
    return `runs \`git ${argv[1] ?? ''}\`, which is not a plain read`
  }
  const writing = WRITING_FLAGS.get(head)
  if (writing && argv.slice(1).some((arg) => writing.test(arg))) {
    return `\`${head}\` is asked to write or execute, not just read`
  }
  return null
}

/**
 * Classify a shell command as a fully-accounted-for read of paths outside the
 * project. See the module comment for the safety model.
 */
export function analyzeReadOutsideProject(
  command: string,
  workspaceRoot: string | null,
  options: AnalyzeOptions = {},
): ReadOutsideProjectAnalysis {
  const trimmed = command.trim()
  if (!trimmed) return INELIGIBLE(['empty command'])
  // Without a project root there is no inside/outside to reason about.
  if (!workspaceRoot) return INELIGIBLE(['no project root'])

  const root = resolve(workspaceRoot)
  const homeDir = options.homeDir ?? homedir()

  const blockers: string[] = []
  const addBlocker = (blocker: string): void => {
    if (!blockers.includes(blocker)) blockers.push(blocker)
  }

  // The shape checks say "this only reads"; this says "and a read is all it
  // needs". It is the same condition the execution half applies, so the two
  // halves agree by construction rather than by coincidence: a command the shell
  // tool would decline to contain (network signal, opaque local execution) must
  // not be offered the read question, or approving it would run it fully
  // unsandboxed on an answer that was only ever about reads. Today the head
  // allow-list already excludes those shapes; this keeps it true if either list
  // moves. Deliberately the path-independent half — this module recognises
  // `${HOME}/…` as an outside path and `shell-scope` does not, so asking the
  // full predicate would refuse reads that are perfectly eligible.
  if (needsMoreThanOutsideAccess(trimmed)) {
    addBlocker('needs more than reads outside the project')
  }

  const expansion = expansionBlocker(trimmed)
  if (expansion) addBlocker(expansion)
  for (const reason of dangerousInSandboxReasons(trimmed)) addBlocker(reason)
  // `2>/dev/null` is noise suppression, not a write; anything else opens a file.
  for (const redirect of shellRedirects(trimmed)) {
    if (redirect.target !== '/dev/null') addBlocker(`writes to ${redirect.target}`)
  }

  const targets: string[] = []
  const resolvedTargets: string[] = []
  // `shellSegments` unions two lexers and deliberately over-segments; that can
  // only ever add a blocker or a target here, never remove one.
  for (const rawArgv of shellSegments(trimmed)) {
    const argv = unwrapWrappers(rawArgv)
    if (argv.length === 0) continue
    const head = headBlocker(rawArgv, argv)
    if (head) addBlocker(head)
    for (const token of argv.slice(1)) {
      if (token.startsWith('-') || !looksLikePath(token)) continue
      const resolved = resolveTarget(token, root, homeDir)
      if (isInsideProject(resolved, root)) continue
      const sensitive = sensitiveTargetReason(token, resolved)
      if (sensitive) addBlocker(`reads a ${sensitive}`)
      const breadth = breadthBlocker(token, resolved, homeDir)
      if (breadth) addBlocker(`reads ${breadth}`)
      if (targets.includes(token)) continue
      targets.push(token)
      resolvedTargets.push(resolved)
    }
  }

  if (targets.length === 0) addBlocker('reads nothing outside the project')
  if (blockers.length > 0) return INELIGIBLE(blockers)
  return { eligible: true, targets, resolvedTargets, blockers: [] }
}

/**
 * The absolute paths a seatbelt may be widened to for this command, or null when
 * it must keep today's routing.
 *
 * This is the *execution* half of the read-access grant: the gate asks the user
 * the read question, and this answers "so what may the sandbox actually read?".
 * Both halves derive from {@link analyzeReadOutsideProject} on the SAME raw
 * command, so the decision and the overlay can never disagree — the discipline
 * `routeShellCommand`/`shellRunsOutsideSandbox` already use for the sandboxed vs
 * unsandboxed split. Nothing is threaded from the gate, so there is no gap
 * between what was approved and what is relaxed.
 *
 * Returns null unless the command is an accountable read AND its only reason for
 * leaving the sandbox is the out-of-project path. A command with any network
 * signal keeps running unsandboxed under its own approval: containing it would
 * break it, and a read grant is not the permission it needs.
 */
export function readOutsideProjectGrantTargets(
  command: string,
  workspaceRoot: string | null,
  options: AnalyzeOptions = {},
): string[] | null {
  const analysis = analyzeReadOutsideProject(command, workspaceRoot, options)
  if (!analysis.eligible || analysis.resolvedTargets.length === 0) return null
  if (!externalOnlyForOutsidePath(command, workspaceRoot)) return null
  return analysis.resolvedTargets
}

/** At most this many paths are listed before the copy falls back to a count. */
const MAX_LISTED_TARGETS = 3

/** The out-of-project paths, phrased for the approval prompt. */
export function describeReadOutsideTargets(targets: readonly string[]): string {
  if (targets.length <= MAX_LISTED_TARGETS) return targets.join(', ')
  const shown = targets.slice(0, MAX_LISTED_TARGETS).join(', ')
  return `${shown} and ${String(targets.length - MAX_LISTED_TARGETS)} more`
}

export const READ_OUTSIDE_PROJECT_TITLE = 'Allow read access outside of the project?'

/**
 * The warning stays on the prompt even though the shape is a read: a grant does
 * widen what the agent can see, and the user is the one who knows whether the
 * paths in question are sensitive.
 */
export const READ_OUTSIDE_PROJECT_WARNING =
  'This may allow the agent to read from sensitive locations on your computer.'

export function formatReadOutsideProjectPromptParts(
  command: string,
  analysis: ReadOutsideProjectAnalysis,
): ShellPromptParts {
  return {
    command,
    bodyAdvice:
      `The agent wants to read outside the project: ${describeReadOutsideTargets(analysis.targets)}\n\n` +
      `⚠️ ${READ_OUTSIDE_PROJECT_WARNING}`,
    bodyFooter:
      'Approving allows reads outside the project for the rest of this thread. ' +
      'It does not allow writing, installing, or network access, and credential ' +
      'files (.env, ~/.ssh, ~/.aws) always ask again.',
  }
}
