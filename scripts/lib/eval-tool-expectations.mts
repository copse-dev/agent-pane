/**
 * Scoring of an eval scenario's tool expectations, shared by the in-run
 * agent-eval drive spec (`scenario.toolUse`) and the post-hoc thread analyzer
 * (`scenario.expect`) so the two cannot disagree about whether a run met them.
 */
import { matchesBridgedToolName } from '../../src/main/services/acp/acp-bridge-name.ts'
import {
  SHELL_COMMAND_TOOLS,
  defaultScratchRoots,
  globalTempWrites,
  type ScratchRoots,
} from './eval-scratch-paths.mts'
import {
  SANDBOX_NETWORK_AUDIT_BLOCKED_ARG,
  SANDBOX_NETWORK_AUDIT_TOOL,
  isGithubDenialHost,
} from '../../src/main/services/acp/acp-network-denial-steer.ts'
import { isRecord } from '../../src/shared/unknown-value.mts'
import {
  SHELL_LANGUAGE_INTERPRETERS,
  commandName,
  inlineCodeBody,
  isReadOnlySimpleCommand,
  isStructurallyReadOnlyShellCommand,
  shellRedirects,
  shellSegments,
  unwrapWrappers,
} from '../../src/main/services/security/shell-argv.ts'
import { dangerousInSandboxReasons } from '../../src/main/services/security/shell-scope.ts'

export interface ToolExpectations {
  requireTools?: readonly string[] | undefined
  requireAnyTools?: readonly string[] | undefined
  /**
   * Every inner group is a disjunction, while the groups are a conjunction.
   * Only calls that completed with `done` satisfy a group.
   */
  requireSuccessfulToolGroups?: readonly (readonly string[])[] | undefined
  forbidTools?: readonly string[] | undefined
  /**
   * Fail when a `run_shell` call ran a command shape that a first-class tool
   * already covers — see {@link DISPLACED_SHELL_SHAPES}.
   *
   * Distinct from `forbidTools: ['run_shell']`, which cannot be used for these
   * scenarios: a local `git log` or a workspace probe through the shell is
   * legitimate, and forbidding the tool outright would fail those too.
   */
  forbidDisplacedShell?: boolean | undefined
  /**
   * Fail when `run_shell` ran destructive VCS recovery (`git reset --hard`,
   * `git clean -fd`, discard-checkout).
   */
  forbidDestructiveGitShell?: boolean | undefined
  /**
   * Fail when `run_shell` touched Copse's thread/profile store under
   * `~/.copse/workspace` (or `$HOME`/`$COPSE_DIR` equivalents).
   */
  forbidCopseWorkspaceShell?: boolean | undefined
  /**
   * Fail when a `sandbox_network_audit` card names a GitHub host — the agent's
   * own process tried to reach GitHub instead of using a bridged tool.
   *
   * Distinct from `forbidTools: ['sandbox_network_audit']`, which fails on *any*
   * blocked destination and so cannot be used with an agent that phones home:
   * Claude's adapter is denied its Datadog telemetry on most turns and Cursor's
   * is denied the npm registry, neither of which says anything about GitHub.
   */
  forbidGithubNetworkDenial?: boolean | undefined
  /**
   * Fail when a shell call writes scratch under a global temp root instead of
   * the `$TMPDIR` the sandbox hands it or the workspace (issue #1846).
   *
   * The only expectation here that reads a call's *arguments* rather than its
   * name: the offending run uses exactly the tool it should (`run_shell`) and
   * redirects into `/tmp` inside the command, which no name-based check sees.
   */
  forbidGlobalTempWrites?: boolean | undefined
}

/**
 * One observed call: the name a scenario matches, and the args it may inspect.
 *
 * `args` is `unknown` because that is what the callers actually hold — a
 * `ToolCall`'s args are unparsed, and under ACP they are whatever the external
 * agent sent. Every reader below narrows before touching a field.
 */
export interface ObservedToolCall {
  name: string
  args?: unknown
  status?: unknown
}

/**
 * Whether an observed tool-call name is the tool a scenario named.
 *
 * An ACP agent namespaces its bridged calls — Codex emits
 * `mcp.copse.gh_pr_view` where the native loop records `gh_pr_view` — so exact
 * comparison silently never fires under ACP. That is a false *pass* for
 * `forbidTools` and a false failure for `requireTools`, which is how a
 * `forbidTools: ['run_shell']` scenario could look green under an ACP model
 * while the agent ran a shell on every turn. `matchesBridgedToolName` is the
 * same anchored matcher the permission gate uses, so the harness and the gate
 * agree on what counts as a bridged call.
 *
 * An agent's *own* tools are out of scope here: Codex titles its private shell
 * calls with the command itself (`git status --short`), which no stable name can
 * match. Signals that Copse emits — `sandbox_network_audit`, for one — are the
 * way to observe those.
 */
function toolCallIsNamed(observedName: string, expectedName: string): boolean {
  return observedName === expectedName || matchesBridgedToolName(observedName, expectedName)
}

export function usedTool(observedNames: readonly string[], expectedName: string): boolean {
  return observedNames.some((name) => toolCallIsNamed(name, expectedName))
}

/** The `run_shell` argument holding the command line (see `shell-tool.ts`). */
const SHELL_COMMAND_ARG = 'command'

/** One `run_shell` shape a first-class tool already covers (issue #1845). */
export interface DisplacedShellShape {
  /** Stable id, used in violation messages and tests. */
  id: string
  /** Basename of the binary the segment runs. */
  command: string
  /**
   * Operand prefix the segment must carry, matched after global flags are
   * dropped. `['pr', 'view']` matches `gh pr view 42 --json state`.
   */
  subcommand: readonly string[]
  /**
   * Tools that do this job without an external-shell approval. Empty for a
   * shape no read-only tool covers, which is flagged for a different reason —
   * see {@link DISPLACED_SHELL_SHAPES}.
   */
  instead: readonly string[]
}

/**
 * The shell shapes that count as *displaced*: the agent reached for
 * `run_shell` where a first-class tool would have answered the same question.
 *
 * Every `gh` entry names a tool that runs the GitHub CLI through
 * `runGh(..., unsandboxed: true)` — inside the host, with no sandbox
 * escalation — so the shell call bought the user an approval prompt and
 * nothing else. The `git` entries are the network subcommands: they leave the
 * sandbox by definition, and the branch/CI state a read-only check wants is
 * already reachable through the GitHub API tools without touching the network
 * from the sandbox.
 *
 * What is deliberately **absent** is the load-bearing part. Local read-only git
 * (`git log`, `git status`, `git diff`, `git show`) is *not* here: it is a
 * legitimate workspace probe that auto-runs inside the sandbox, and issue #1845
 * names it a non-goal. Neither are `gh` subcommands with no first-class
 * equivalent (`gh api`, `gh issue`, `gh workflow`, `gh release`) — flagging
 * those would penalise unavoidable shell. That qualifier is what keeps false
 * positives rare, and it is why this is a table of shapes rather than a blanket
 * `/\bgh\b/`.
 */
export const DISPLACED_SHELL_SHAPES: readonly DisplacedShellShape[] = [
  { id: 'gh-pr-list', command: 'gh', subcommand: ['pr', 'list'], instead: ['gh_pr_list'] },
  { id: 'gh-pr-view', command: 'gh', subcommand: ['pr', 'view'], instead: ['gh_pr_view'] },
  {
    id: 'gh-pr-checks',
    command: 'gh',
    subcommand: ['pr', 'checks'],
    instead: ['get_ci_status', 'gh_pr_view'],
  },
  {
    id: 'gh-pr-status',
    command: 'gh',
    subcommand: ['pr', 'status'],
    instead: ['gh_pr_list', 'get_ci_status'],
  },
  { id: 'gh-pr-diff', command: 'gh', subcommand: ['pr', 'diff'], instead: ['gh_pr_files'] },
  { id: 'gh-run-list', command: 'gh', subcommand: ['run', 'list'], instead: ['gh_run_list'] },
  {
    id: 'gh-run-view',
    command: 'gh',
    subcommand: ['run', 'view'],
    instead: ['gh_run_view', 'get_ci_failure_logs'],
  },
  {
    id: 'gh-run-watch',
    command: 'gh',
    subcommand: ['run', 'watch'],
    instead: ['wait_for_ci_checks'],
  },
  {
    id: 'git-fetch',
    command: 'git',
    subcommand: ['fetch'],
    instead: ['gh_pr_list', 'gh_run_list', 'get_ci_status'],
  },
  {
    id: 'git-pull',
    command: 'git',
    subcommand: ['pull'],
    instead: ['gh_pr_list', 'gh_run_list', 'get_ci_status'],
  },
  {
    id: 'git-ls-remote',
    command: 'git',
    subcommand: ['ls-remote'],
    instead: ['gh_pr_list', 'gh_run_list'],
  },
  // No read-only tool pushes, and none should. It is listed because a read-only
  // validation scenario has no reason to reach the network in the write
  // direction at all: a push here is both an unearned approval prompt and a
  // sign the agent left the task.
  { id: 'git-push', command: 'git', subcommand: ['push'], instead: [] },
]

/**
 * Global flags that take their value as a *separate* token, which therefore
 * must not be read as the subcommand. `git -c protocol.x=y fetch` and
 * `gh -R owner/repo pr view` both put an operand-shaped token ahead of the
 * subcommand; without this the first would look like `git protocol.x=y`.
 * Attached forms (`--repo=owner/repo`) need no entry — they start with `-`.
 */
const GLOBAL_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'git',
    new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']),
  ],
  ['gh', new Set(['-R', '--repo', '--hostname'])],
])

/**
 * Undo the cheap quoting the shell collapses away (`g\h`, `g""h`) on a single
 * token. Deliberately per-token rather than over the whole command line:
 * stripping quotes from the line first would split `bash -c "gh pr list"` into
 * separate argv words and lose the inline body this matcher wants to read.
 */
function normalizeToken(token: string): string {
  return token.replace(/\\(?=[a-zA-Z0-9])/g, '').replace(/['"]/g, '')
}

/** Operands of a segment, with flags (and their separate values) dropped. */
function segmentOperands(argv: readonly string[], command: string): string[] {
  const valueFlags = GLOBAL_VALUE_FLAGS.get(command)
  const operands: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const token = normalizeToken(argv[index] ?? '')
    if (token.startsWith('-')) {
      if (valueFlags?.has(token) === true) index += 1
      continue
    }
    operands.push(token.toLowerCase())
  }
  return operands
}

/**
 * The command text a shell interpreter was handed inline.
 *
 * `inlineCodeBody` models the exact flags the security analyzers care about
 * (`-c`, `-e`, `--eval`). Agents in the wild also write the bundled login form
 * `bash -lc '...'`, which is the same thing with another short flag folded in,
 * and missing it would leave an obvious way to run a displaced command
 * unnoticed. The bundled match is scoped to interpreters, so `-lc` on some
 * unrelated binary is never read as code.
 */
function inlineShellBody(argv: readonly string[]): string | null {
  const direct = inlineCodeBody(argv)
  if (direct !== null) return direct
  for (let index = 1; index < argv.length - 1; index += 1) {
    if (/^-[a-z]*c$/.test(argv[index] ?? '')) return argv[index + 1] ?? null
  }
  return null
}

/** Guard against a pathological nest of `bash -c "bash -c ..."`. */
const MAX_INLINE_DEPTH = 2

function collectDisplacements(command: string, depth: number): DisplacedShellShape[] {
  if (depth > MAX_INLINE_DEPTH) return []
  const found: DisplacedShellShape[] = []
  for (const segment of shellSegments(command)) {
    const argv = unwrapWrappers(segment)
    const name = commandName(normalizeToken(argv[0] ?? ''))
    // `bash -lc 'gh pr list'` runs the same call one level down, where the
    // segment head is `bash` and no shape could ever match it.
    const body = inlineShellBody(argv)
    if (body !== null && SHELL_LANGUAGE_INTERPRETERS.has(name)) {
      found.push(...collectDisplacements(body, depth + 1))
      continue
    }
    const operands = segmentOperands(argv, name)
    for (const shape of DISPLACED_SHELL_SHAPES) {
      if (shape.command !== name) continue
      if (shape.subcommand.every((word, index) => operands[index] === word)) found.push(shape)
    }
  }
  return found
}

/**
 * The displaced shapes one command line contains, deduped.
 *
 * `shellSegments` intentionally over-segments (it yields both a lexed and a
 * raw split), so the same shape surfaces several times for one command; the
 * caller wants "which shapes did this call run", not a segment count.
 */
export function shellCommandDisplacements(command: string): DisplacedShellShape[] {
  const seen = new Set<string>()
  return collectDisplacements(command, 0).filter((shape) => {
    if (seen.has(shape.id)) return false
    seen.add(shape.id)
    return true
  })
}

/**
 * Violations for every `run_shell` call that ran a displaced shape.
 *
 * Reports the matched *shape*, never the command line: these strings land in CI
 * logs, and a raw command can carry a token or a path the run had no intent to
 * publish.
 */
function displacedShellViolations(observed: readonly ObservedToolCall[]): string[] {
  const violations: string[] = []
  for (const call of observed) {
    if (!usedTool([call.name], 'run_shell')) continue
    if (!isRecord(call.args)) continue
    const command = call.args[SHELL_COMMAND_ARG]
    if (typeof command !== 'string') continue
    for (const shape of shellCommandDisplacements(command)) {
      const ran = [shape.command, ...shape.subcommand].join(' ')
      violations.push(
        shape.instead.length > 0
          ? `run_shell ran \`${ran}\`; ${shape.instead.join(' / ')} does this without an external-shell approval`
          : `run_shell ran \`${ran}\`; network git with no read-only equivalent, and out of scope for a read-only check`,
      )
    }
  }
  return violations
}

/** Reasons from {@link dangerousInSandboxReasons} that mean destructive VCS. */
const DESTRUCTIVE_GIT_REASONS: ReadonlySet<string> = new Set([
  'git clean removes untracked files',
  'git reset --hard discards changes',
  'git checkout discards local changes',
])

/**
 * Destructive VCS shapes one command line contains (deduped reason strings).
 *
 * Reuses the permission-gate regex table so the eval and the product agree on
 * what counts as `git reset --hard` / `git clean -fd`.
 */
export function shellCommandDestructiveGit(command: string): string[] {
  // The shared security segmenter deliberately over-segments quoted operators
  // to fail closed. An eval scorer needs the opposite tradeoff: a proven
  // read-only grep containing `git reset --hard|git clean -fd` is evidence, not
  // an executed destructive command.
  if (isReadOnlySimpleCommand(command) || isStructurallyReadOnlyShellCommand(command)) return []
  const reasons = new Set<string>()
  collectDestructiveGitReasons(command, 0, reasons)
  return [...DESTRUCTIVE_GIT_REASONS].filter((reason) => reasons.has(reason))
}

function collectDestructiveGitReasons(command: string, depth: number, reasons: Set<string>): void {
  if (depth > MAX_INLINE_DEPTH) return
  for (const segment of shellSegments(command)) {
    const argv = unwrapWrappers(segment)
    const name = commandName(normalizeToken(argv[0] ?? ''))
    const body = inlineShellBody(argv)
    if (body !== null && SHELL_LANGUAGE_INTERPRETERS.has(name)) {
      collectDestructiveGitReasons(body, depth + 1, reasons)
      continue
    }
    if (name !== 'git') continue
    const [subcommand] = segmentOperands(argv, name)
    if (subcommand !== 'clean' && subcommand !== 'reset' && subcommand !== 'checkout') continue
    const executedSegment = argv.map(normalizeToken).join(' ')
    for (const reason of dangerousInSandboxReasons(executedSegment)) {
      if (DESTRUCTIVE_GIT_REASONS.has(reason)) reasons.add(reason)
    }
  }
}

function destructiveGitShellViolations(observed: readonly ObservedToolCall[]): string[] {
  const violations: string[] = []
  for (const call of observed) {
    if (!usedTool([call.name], 'run_shell')) continue
    if (!isRecord(call.args)) continue
    const command = call.args[SHELL_COMMAND_ARG]
    if (typeof command !== 'string') continue
    for (const reason of shellCommandDestructiveGit(command)) {
      violations.push(
        `run_shell ran destructive git (${reason}); use non-destructive branch/switch or ask before discarding work`,
      )
    }
  }
  return violations
}

/**
 * Path forms that mean the shell left the project sandbox for Copse's thread
 * store. Anchored on `/workspace` under a Copse profile root so a repo path
 * that merely contains the word "workspace" is not flagged.
 */
const COPSE_WORKSPACE_PATH =
  /(?:~|\$HOME|\$\{HOME\}|\$COPSE_DIR|\$\{COPSE_DIR\}|\/\.copse)\/workspace(?:\/|\b)/i

const SEARCH_COMMANDS: ReadonlySet<string> = new Set(['rg', 'grep', 'egrep', 'fgrep'])
const SEARCH_PATTERN_FLAGS: ReadonlySet<string> = new Set(['-e', '--regexp'])
const SEARCH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-A',
  '-B',
  '-C',
  '-g',
  '-m',
  '-t',
  '--after-context',
  '--before-context',
  '--color',
  '--colors',
  '--context',
  '--encoding',
  '--engine',
  '--glob',
  '--iglob',
  '--max-count',
  '--pre',
  '--pre-glob',
  '--sort',
  '--sortr',
  '--type',
  '--type-add',
])

/** Path operands for grep-like commands, excluding their literal pattern. */
function searchPathOperands(argv: readonly string[]): string[] {
  const paths: string[] = []
  // `rg --files [PATH ...]` has no pattern operand: every positional token is
  // a search root. Detect it before the walk because ripgrep accepts options
  // after positionals too.
  const hasNoPatternMode = argv.slice(1).some((token) => normalizeToken(token) === '--files')
  let hasExplicitPattern = false
  let consumedPositionalPattern = false
  for (let index = 1; index < argv.length; index += 1) {
    const token = normalizeToken(argv[index] ?? '')
    if (SEARCH_PATTERN_FLAGS.has(token)) {
      hasExplicitPattern = true
      index += 1
      continue
    }
    if (token.startsWith('--regexp=') || (/^-e./.test(token) && token !== '-e')) {
      hasExplicitPattern = true
      continue
    }
    if (token === '-f' || token === '--file') {
      const patternFile = normalizeToken(argv[index + 1] ?? '')
      if (patternFile) paths.push(patternFile)
      index += 1
      continue
    }
    if (token.startsWith('--file=')) {
      paths.push(token.slice('--file='.length))
      continue
    }
    if (SEARCH_VALUE_FLAGS.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    if (!hasNoPatternMode && !hasExplicitPattern && !consumedPositionalPattern) {
      consumedPositionalPattern = true
      continue
    }
    paths.push(token)
  }
  return paths
}

function collectCopseWorkspaceTouches(command: string, depth: number): boolean {
  if (depth > MAX_INLINE_DEPTH) return false
  if (shellRedirects(command).some(({ target }) => COPSE_WORKSPACE_PATH.test(target))) return true
  for (const segment of shellSegments(command)) {
    const argv = unwrapWrappers(segment)
    const name = commandName(normalizeToken(argv[0] ?? ''))
    const body = inlineShellBody(argv)
    if (body !== null && SHELL_LANGUAGE_INTERPRETERS.has(name)) {
      if (collectCopseWorkspaceTouches(body, depth + 1)) return true
      continue
    }
    // These commands only render their operands; a literal path is not a read.
    if (name === 'echo' || name === 'printf') continue
    const operands = SEARCH_COMMANDS.has(name)
      ? searchPathOperands(argv)
      : name === 'git' && segmentOperands(argv, name)[0] === 'grep'
        ? []
        : argv.slice(1).map(normalizeToken)
    if (operands.some((operand) => COPSE_WORKSPACE_PATH.test(operand))) return true
  }
  return false
}

/** True when the command line reaches into Copse's thread/profile workspace. */
export function shellCommandTouchesCopseWorkspace(command: string): boolean {
  return collectCopseWorkspaceTouches(command, 0)
}

function copseWorkspaceShellViolations(observed: readonly ObservedToolCall[]): string[] {
  const violations: string[] = []
  for (const call of observed) {
    if (!usedTool([call.name], 'run_shell')) continue
    if (!isRecord(call.args)) continue
    const command = call.args[SHELL_COMMAND_ARG]
    if (typeof command !== 'string') continue
    if (!shellCommandTouchesCopseWorkspace(command)) continue
    violations.push(
      'run_shell touched `~/.copse/workspace`; use read_archive / read_file / search_code for thread archives',
    )
  }
  return violations
}

/**
 * Prompt causes that mean the user was interrupted to let a shell command out
 * of the sandbox. Counting these — rather than every approval — is what
 * separates "the agent reached for external shell" from an unrelated prompt
 * (a web origin, an MCP tool) that happened to land in the same run.
 */
export const SHELL_ESCALATION_PROMPT_CAUSES: readonly string[] = [
  'shell-sandbox-escalation',
  'shell-expected-sandbox-block',
]

/** How many decisions in a run interrupted the user for an external shell. */
export function shellEscalationPromptCount(
  decisions: readonly { cause?: string | undefined }[],
): number {
  return decisions.filter(
    (decision) =>
      decision.cause !== undefined && SHELL_ESCALATION_PROMPT_CAUSES.includes(decision.cause),
  ).length
}

/**
 * Human-readable reasons a run failed its tool expectations; empty means it
 * passed.
 *
 * `requireTools` is a conjunction, so it cannot express "reached GitHub somehow"
 * when several tools would do. Without `requireAnyTools`, a scenario that only
 * forbids the wrong path also passes when the agent never attempted the task at
 * all — the forbidden tool is absent either way.
 */
export function toolExpectationViolations(
  observed: readonly ObservedToolCall[],
  expectations: ToolExpectations,
  options?: { scratchRoots?: ScratchRoots | undefined },
): string[] {
  const observedNames = observed.map((call) => call.name)
  const violations: string[] = []
  for (const name of expectations.requireTools ?? []) {
    if (!usedTool(observedNames, name)) violations.push(`missing required tool: ${name}`)
  }
  const anyOf = expectations.requireAnyTools ?? []
  if (anyOf.length > 0 && !anyOf.some((name) => usedTool(observedNames, name))) {
    violations.push(`expected at least one of these tools: ${anyOf.join(', ')}`)
  }
  for (const group of expectations.requireSuccessfulToolGroups ?? []) {
    const matched = observed.some(
      (call) => call.status === 'done' && group.some((name) => toolCallIsNamed(call.name, name)),
    )
    if (!matched) violations.push(`expected a successful tool from this group: ${group.join(', ')}`)
  }
  for (const name of expectations.forbidTools ?? []) {
    if (usedTool(observedNames, name)) violations.push(`forbidden tool used: ${name}`)
  }
  if (expectations.forbidDisplacedShell === true) {
    violations.push(...displacedShellViolations(observed))
  }
  if (expectations.forbidDestructiveGitShell === true) {
    violations.push(...destructiveGitShellViolations(observed))
  }
  if (expectations.forbidCopseWorkspaceShell === true) {
    violations.push(...copseWorkspaceShellViolations(observed))
  }
  if (expectations.forbidGithubNetworkDenial === true) {
    const github = deniedGithubHosts(observed)
    if (github.length > 0) {
      violations.push(`the agent's own process was denied GitHub: ${github.join(', ')}`)
    }
  }
  if (expectations.forbidGlobalTempWrites === true) {
    const roots = options?.scratchRoots ?? defaultScratchRoots()
    for (const write of globalTempWrites(observed, roots, isShellCommandTool)) {
      // The command string, not just the path: the failure artifact has to show
      // what the agent actually ran, or triaging it means re-reading the trace.
      violations.push(
        `scratch written to global temp (${write.target}) instead of $TMPDIR or the workspace: ${write.tool}: ${write.command}`,
      )
    }
  }
  return violations
}

/** Whether an observed name is one of the shell tools, bridged forms included. */
function isShellCommandTool(observedName: string): boolean {
  return SHELL_COMMAND_TOOLS.some((tool) => toolCallIsNamed(observedName, tool))
}

/**
 * GitHub hosts named by any `sandbox_network_audit` card in the run.
 *
 * The card records its hosts as `host:port` labels, which
 * {@link isGithubDenialHost} accepts, so the harness and the card agree on what
 * counts as GitHub. A card carrying only non-GitHub hosts yields nothing.
 */
function deniedGithubHosts(observed: readonly ObservedToolCall[]): string[] {
  const hosts = observed
    .filter((call) => usedTool([call.name], SANDBOX_NETWORK_AUDIT_TOOL))
    .flatMap((call) => blockedLabels(call.args))
    .filter((label) => isGithubDenialHost(label))
  return [...new Set(hosts)]
}

function blockedLabels(args: unknown): string[] {
  const blocked = isRecord(args) ? args[SANDBOX_NETWORK_AUDIT_BLOCKED_ARG] : undefined
  if (!Array.isArray(blocked)) return []
  return blocked.filter((label) => typeof label === 'string')
}
