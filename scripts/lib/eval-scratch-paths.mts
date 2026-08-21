/**
 * Where an eval run's shell commands put their scratch files (issue #1846).
 *
 * Sandboxed runs already get a workspace-owned temp dir: the seatbelt allows it
 * and the spawn points `$TMPDIR`/`TMP`/`TEMP` at it (#481). Models nonetheless
 * hardcode `/tmp/...`, which `shell-scope.ts` classifies as a global temp path
 * and therefore external — so a scratch write that had a sanctioned home
 * instead costs the user a "Run outside sandbox?" approval, or an EPERM on a
 * path that cannot escalate cleanly. `ACP_SANDBOX_PROMPT_NOTE` says as much in
 * words; nothing measured whether a real turn obeys it.
 *
 * Scoring here looks at the **command string**, not the tool name: an agent that
 * calls the sanctioned `run_shell` and redirects into `/tmp` inside it passes
 * every name-based expectation. The matcher is deliberately narrow — a target
 * only counts when the command demonstrably opens it for writing — because a
 * scorer that fired on any mention of `/tmp` would fail runs that merely read a
 * path the user named, and an eval that cries wolf gets muted.
 *
 * Reading from `/tmp` is out of scope on purpose. It is a real (smaller)
 * approval cost, but it is the scope classifier's business (#1845 covers
 * tool-choice approvals), and conflating the two would make this eval's failures
 * ambiguous about which contract broke.
 */
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  SHELL_INTERPRETERS,
  commandName,
  inlineCodeBody,
  shellRedirects,
  shellSegments,
  unwrapWrappers,
} from '../../src/main/services/security/shell-argv.ts'
import { copseWorkspaceTmpDir } from '../../src/main/services/storage/copse-paths.ts'

/**
 * Tools whose `command` argument is a shell command line.
 *
 * Both are bridged to ACP agents under these names, so
 * {@link matchesBridgedToolName} in the caller finds the namespaced forms too.
 * An ACP agent's *private* shell is not observable here — Codex titles those
 * calls with the command itself — which is the reason the steer tells agents to
 * come through `run_shell` in the first place.
 */
export const SHELL_COMMAND_TOOLS = ['run_shell', 'run_background'] as const

/** The argument both shell tools carry their command line in. */
export const SHELL_COMMAND_ARG = 'command'

/** Redirect targets that open no file, so they can never be a scratch write. */
const DISCARD_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
])

/** How a write verb's operands map to the files it opens. */
type OperandRule = 'all' | 'last'

/**
 * Commands whose operands name files they create or overwrite.
 *
 * `last` for the copy/move family, whose leading operands are sources being
 * *read*: `cp /tmp/in ./out` reads from global temp and writes into the
 * workspace, which is not the failure this eval is about.
 *
 * `mktemp` is here for its template operand (`mktemp /tmp/x.XXXXXX`). A bare
 * `mktemp` has no operand and so yields nothing — correctly, since that is the
 * sanctioned form: it honours the `$TMPDIR` the sandbox overlays.
 */
const WRITE_VERB_OPERANDS: ReadonlyMap<string, OperandRule> = new Map([
  ['tee', 'all'],
  ['touch', 'all'],
  ['mkdir', 'all'],
  ['mkfifo', 'all'],
  ['mktemp', 'all'],
  ['cp', 'last'],
  ['mv', 'last'],
  ['install', 'last'],
  ['rsync', 'last'],
  ['ln', 'last'],
])

/**
 * Flags whose value is a file the command writes, in both `--flag value` and
 * `--flag=value` spellings. `dd` spells its destination `of=PATH` with no
 * leading dashes, which the `=`-suffixed form already covers.
 */
const WRITE_TARGET_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['curl', new Set(['-o', '--output'])],
  ['wget', new Set(['-O', '--output-document'])],
  ['dd', new Set(['of'])],
  ['mktemp', new Set(['-p', '--tmpdir'])],
  ['git', new Set(['--output'])],
])

/** Env vars the sandbox overlays at the sanctioned scratch dir (see spawn.ts). */
const TMPDIR_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const

/**
 * `sh -c 'cmd > /tmp/x'` hides its redirect inside a single quoted token, so the
 * outer parse sees no redirect at all. One level of recursion covers the shapes
 * an agent actually emits; the bound stops a pathological nest from looping.
 */
const MAX_INLINE_DEPTH = 3

export interface ScratchRoots {
  /**
   * Roots a scratch file may legitimately live in: the `$TMPDIR` the sandbox
   * hands the shell, plus the workspace itself.
   */
  allowed: readonly string[]
  /**
   * Roots that count as global/system temp. macOS `/var/folders/...` is on this
   * list, which is why {@link allowed} is checked first: on an unsandboxed host
   * that same path *is* the active `$TMPDIR`, and failing it there would fail
   * runs that did exactly the right thing.
   */
  global: readonly string[]
}

/**
 * The roots the harness scores against.
 *
 * `$TMPDIR` resolves through {@link copseWorkspaceTmpDir} — the same resolver
 * the seatbelt overlay and the spawn use — so the eval cannot drift from the
 * contract the steer text describes. An explicit `tmpdir` override exists for
 * runs whose shell got a different `$TMPDIR` than this process would compute.
 */
export function defaultScratchRoots(opts?: {
  workspaceRoot?: string | undefined
  tmpdir?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}): ScratchRoots {
  const env = opts?.env ?? process.env
  const sanctionedTmp = opts?.tmpdir ?? copseWorkspaceTmpDir(env)
  const allowed = [sanctionedTmp, ...(opts?.workspaceRoot ? [opts.workspaceRoot] : [])]
  return {
    allowed: allowed.flatMap((root) => canonicalTwins(resolve(root))),
    global: ['/tmp', '/var/tmp', tmpdir()].flatMap((root) => canonicalTwins(resolve(root))),
  }
}

/**
 * A path and its `/private`-prefixed twin.
 *
 * macOS resolves `/tmp` and `/var/folders` through `/private`, and which
 * spelling shows up depends on whether anything canonicalized the path on the
 * way. Comparing against both is cheaper than realpath-ing a target that may
 * not exist.
 */
function canonicalTwins(path: string): string[] {
  if (path.startsWith('/private/')) return [path, path.slice('/private'.length)]
  return [path, `/private${path}`]
}

function isUnder(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * Whether a write target lands in global temp rather than a sanctioned root.
 *
 * Order matters: a target inside an allowed root is never global, so a host
 * whose real `$TMPDIR` is `/var/folders/...` passes. A `$TMPDIR`-relative target
 * is allowed by inspection of the variable itself — the harness cannot expand it
 * to the value the sandboxed shell saw, and expanding it to this process's own
 * would be a guess.
 */
export function isGlobalTempWriteTarget(target: string, roots: ScratchRoots): boolean {
  const trimmed = target.trim()
  if (trimmed.length === 0 || DISCARD_TARGETS.has(trimmed)) return false
  if (TMPDIR_VARS.some((name) => new RegExp(`^\\$\\{?${name}\\b`).test(trimmed))) return false
  // Relative targets resolve against the agent's cwd, which is the workspace.
  if (!isAbsolute(trimmed)) return false
  const resolved = resolve(trimmed)
  if (roots.allowed.some((root) => isUnder(root, resolved))) return false
  return roots.global.some((root) => isUnder(root, resolved))
}

/**
 * Files a single command line opens for writing.
 *
 * Redirect targets come from {@link shellRedirects}, the same primitive the harm
 * gate and the auto-approval redirect check use, so the eval and the product
 * agree on what a write redirect is. Argv-based verbs are the documented table
 * above rather than "any command with a path operand", which would have flagged
 * every `cat`, `rg`, and `git diff`.
 *
 * Known gap: a write performed inside interpreter source (`python -c
 * "open('/tmp/x','w')"`) is not detected. Inline *shell* code is, by recursion.
 *
 * Deduplicated because {@link shellSegments} deliberately returns overlapping
 * segmentations — harmless for a security analyzer that only ever adds reasons,
 * but here it would report the same offending write several times.
 */
export function shellWriteTargets(command: string, depth = 0): string[] {
  const targets = shellRedirects(command)
    .map((redirect) => redirect.target)
    .filter((target) => !DISCARD_TARGETS.has(target))
  for (const rawArgv of shellSegments(command)) {
    const argv = unwrapWrappers(rawArgv)
    const verb = commandName(argv[0])
    const operands = argv.slice(1)
    const flags = WRITE_TARGET_FLAGS.get(verb)
    if (flags) {
      for (const [index, token] of operands.entries()) {
        const next = operands[index + 1]
        if (flags.has(token) && next !== undefined) targets.push(next)
        const named = [...flags].find((flag) => token.startsWith(`${flag}=`))
        if (named) targets.push(token.slice(named.length + 1))
      }
    }
    const rule = WRITE_VERB_OPERANDS.get(verb)
    if (rule) {
      const paths = operands.filter((token) => !token.startsWith('-'))
      const chosen = rule === 'all' ? paths : paths.slice(-1)
      targets.push(...chosen)
    }
    if (depth < MAX_INLINE_DEPTH && SHELL_INTERPRETERS.has(verb)) {
      const body = inlineCodeBody(argv)
      if (body) targets.push(...shellWriteTargets(body, depth + 1))
    }
  }
  return [...new Set(targets)]
}

/** One command that wrote scratch outside the sanctioned roots. */
export interface GlobalTempWrite {
  /** The observed tool name, bridged prefix and all, for the failure message. */
  tool: string
  /** The full command line — the artifact has to carry the offending string. */
  command: string
  /** The write target that landed in global temp. */
  target: string
}

/** One observed call, narrowed to what this scorer reads. */
export interface ShellObservation {
  name: string
  args?: Record<string, unknown> | undefined
}

/**
 * Every global-temp scratch write across a run's shell calls.
 *
 * `isShellTool` is injected so the caller supplies its own bridged-name matcher
 * rather than this module growing a second, drifting copy of it.
 */
export function globalTempWrites(
  observed: readonly ShellObservation[],
  roots: ScratchRoots,
  isShellTool: (observedName: string) => boolean,
): GlobalTempWrite[] {
  const writes: GlobalTempWrite[] = []
  for (const call of observed) {
    if (!isShellTool(call.name)) continue
    const command = call.args?.[SHELL_COMMAND_ARG]
    if (typeof command !== 'string' || command.trim().length === 0) continue
    for (const target of shellWriteTargets(command)) {
      if (isGlobalTempWriteTarget(target, roots)) {
        writes.push({ tool: call.name, command, target })
      }
    }
  }
  return writes
}
