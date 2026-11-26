// The execution cell contract (docs/plans/copse-reviewer.md, §Execution
// isolation; binding decisions B1 and B3).
//
// Two privilege domains. The ORCHESTRATOR (this package's pipeline, and later
// the agent loops) holds provider keys, forge tokens and the findings store and
// never runs repository code. The EXECUTION CELL holds two throwaway checkouts
// and a scratch directory and runs the build, the type checker, the linter and
// the tests. A backend is the thing that makes a cell; how strong its wall is
// decides whether a given diff may execute at all (see `decideExecution`).
import type { CheckoutTarget } from './finding.ts'

/**
 * How strong a backend's containment is. Ordered: a process-scoped OS sandbox
 * (macOS seatbelt, Linux bubblewrap) is enough for the author's own tree, where
 * the "attacker" already has a shell on the machine; a contributor's diff gets a
 * throwaway container or VM (B3). `none` is the host process with a scrubbed
 * environment — the backend used only with explicit per-run consent.
 */
export type IsolationStrength = 'none' | 'os-sandbox' | 'container'

/**
 * The §Cell capabilities checklist, as booleans a backend declares about itself.
 * The conformance test (`hostile-fixture.test.ts`) checks each declared
 * capability against a fixture that tries to violate it, so a backend cannot
 * claim a wall it does not build.
 */
export interface IsolationCapabilities {
  /** The cell sees only its checkouts, scratch and the declared read-only paths. */
  readonly filesystemConfined: boolean
  /** The cell's environment carries none of the orchestrator's variables. */
  readonly secretFreeEnvironment: boolean
  /** No network beyond the allowlist (Phase 0: none at all). */
  readonly networkDenied: boolean
  /** Nothing inside the cell survives to the next review. */
  readonly ephemeral: boolean
}

export interface CellCheckouts {
  /** Absolute path of the merge-base checkout. */
  readonly base: string
  /** Absolute path of the head checkout (the change under review). */
  readonly head: string
}

/** What the orchestrator asks a backend to build. */
export interface CellSpec {
  readonly checkouts: CellCheckouts
  /** Absolute path the cell may write freely; created by the orchestrator, destroyed after. */
  readonly scratchDir: string
  /**
   * Absolute paths the cell may read but not write, beyond its checkouts and
   * scratch: a content-addressed dependency store, the Node toolchain.
   */
  readonly readOnlyPaths: readonly string[]
  /**
   * The complete environment the cell's processes receive. Built by
   * {@link cellEnvironment}; a backend may override `HOME` and `TMPDIR` to point
   * inside the cell but adds nothing from the host.
   */
  readonly env: Readonly<Record<string, string>>
}

export interface CellCommand {
  readonly target: CheckoutTarget
  readonly argv: readonly [string, ...string[]]
  readonly timeoutMs: number
  /** Cap on the retained interleaved stdout+stderr; overflow is dropped from the front. */
  readonly maxOutputBytes: number
  /** Cancels this command, including its process group. */
  readonly signal?: AbortSignal | undefined
}

export interface CellCommandResult {
  readonly target: CheckoutTarget
  readonly argv: readonly string[]
  /** `null` when the process died of a signal (including the timeout kill). */
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly durationMs: number
  /** Interleaved stdout and stderr, capped to `maxOutputBytes`, tail retained. */
  readonly output: string
  readonly outputTruncated: boolean
}

export interface ExecutionCell {
  readonly spec: CellSpec
  run(command: CellCommand): Promise<CellCommandResult>
  /** Kill stragglers and drop cell-owned state. Idempotent. */
  destroy(): Promise<void>
}

export interface IsolationBackend {
  /** Stable identifier for reports (`host-process`, `os-sandbox`, `container`). */
  readonly id: string
  readonly strength: IsolationStrength
  readonly capabilities: IsolationCapabilities
  createCell(spec: CellSpec): Promise<ExecutionCell>
}

/** Whose diff is under review: the user's own working tree, or a contributor's. */
export type DiffOrigin = 'own' | 'foreign'

export type ExecutionDecision =
  | { readonly execute: true; readonly reason: string }
  | { readonly execute: false; readonly reason: string }

export interface ExecutionPolicyInput {
  readonly diffOrigin: DiffOrigin
  readonly strength: IsolationStrength
  /**
   * The user consented, for this run, to executing their own diff with no
   * isolation — the mirror of the shell gate's "no sandbox, so prompt" rule.
   * Never consulted for a foreign diff: there is no flag that executes one
   * unisolated (B3).
   */
  readonly unisolatedConsent: boolean
}

/**
 * The trust × isolation table from §Execution isolation, as a function.
 *
 * |                | isolation available            | no isolation                    |
 * | own diff       | execute                        | execute only with consent       |
 * | foreign diff   | container or VM only (B3)      | never                           |
 */
export function decideExecution(input: ExecutionPolicyInput): ExecutionDecision {
  if (input.diffOrigin === 'foreign') {
    if (input.strength === 'container') {
      return { execute: true, reason: 'foreign diff inside an ephemeral container' }
    }
    return {
      execute: false,
      reason:
        input.strength === 'os-sandbox'
          ? 'a foreign diff needs a container or VM; the process-scoped OS sandbox is not enough (B3)'
          : 'a foreign diff is never executed without isolation (B1)',
    }
  }
  if (input.strength !== 'none') {
    return { execute: true, reason: `own diff inside the ${input.strength} backend` }
  }
  if (input.unisolatedConsent) {
    return { execute: true, reason: 'own diff, no isolation, explicit per-run consent' }
  }
  return {
    execute: false,
    reason: 'no isolation backend is available and the run was not consented to unisolated',
  }
}

/**
 * Host variables a cell may inherit. Everything else — provider keys, forge
 * tokens, cloud credentials, `HOME`, whatever the shell exported — stays out.
 * `HOME` and `TMPDIR` are supplied by the backend, pointing inside the cell.
 */
export const CELL_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'] as const

export interface CellEnvironmentOptions {
  /**
   * A checkout-local alias for pnpm's content-addressed store. Stage 0 points
   * this alias at the host store's read-only mount. Keeping the configured
   * path lexically inside the checkout prevents pnpm from trying to register
   * the checkout under the otherwise immutable store's `projects/` directory.
   */
  readonly pnpmStoreDir?: string | undefined
  /**
   * The host's corepack cache, mounted read-only. With `HOME` inside the cell
   * corepack would otherwise see an empty cache and try to download the
   * package manager the repository pins — which the cell's network policy
   * forbids (`COREPACK_ENABLE_NETWORK=0` is always set), so `pnpm` itself
   * would fail before the install started.
   */
  readonly corepackHome?: string | undefined
}

/**
 * Build the cell's environment from the host's: the allowlist above, `CI=1`
 * (so tools pick their non-interactive, colour-free mode), corepack pinned
 * offline, and the dependency store and corepack cache locations.
 * Deterministic in the host env, so a test can pin it.
 */
export function cellEnvironment(
  hostEnv: Readonly<Record<string, string | undefined>>,
  options: CellEnvironmentOptions = {},
): Record<string, string> {
  const env: Record<string, string> = { CI: '1', NO_COLOR: '1', COREPACK_ENABLE_NETWORK: '0' }
  for (const key of CELL_ENV_ALLOWLIST) {
    const value = hostEnv[key]
    if (value !== undefined) env[key] = value
  }
  if (options.pnpmStoreDir !== undefined) {
    env['npm_config_store_dir'] = options.pnpmStoreDir
  }
  if (options.corepackHome !== undefined) {
    env['COREPACK_HOME'] = options.corepackHome
  }
  return env
}

/**
 * Dropped host variables that say where and as whom the review runs, not what
 * it may reach: the login session, the locale, what npm or pnpm exports to
 * the script that launched it, and the install paths a macOS shell exports.
 * Their values are host paths, a user name, a locale or a package name, all of
 * which turn up in ordinary command output; treating them as secrets turned
 * every host path in a report into `[REDACTED_SECRET]/…`. They are still kept
 * out of the cell; this list only stops the redactor from hiding them.
 *
 * Exact names, never a prefix. Neighbouring names do carry credentials:
 * `npm_config_*` is `.npmrc` (registry tokens included), `.npmrc` can override
 * `npm_package_config_*`, pnpm appends the command's arguments to
 * `npm_lifecycle_script`, and `LC_*` is the family SSH's default `SendEnv`
 * forwards, so it is used to smuggle arbitrary variables between hosts.
 * Every variable not named here stays a secret.
 */
const NON_SECRET_HOST_VARIABLES: ReadonlySet<string> = new Set([
  // The login session.
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  // Locale categories beyond the allowlisted `LANG`, `LC_ALL` and `LC_CTYPE`.
  'LANGUAGE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_ADDRESS',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_NAME',
  'LC_PAPER',
  'LC_TELEPHONE',
  // What npm and pnpm export to a package script.
  'INIT_CWD',
  'PNPM_SCRIPT_SRC_DIR',
  'NODE',
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
  'npm_lifecycle_event',
  'npm_package_json',
  'npm_package_name',
  'npm_package_version',
  // What a macOS login exports: Homebrew's and nvm's install paths (from
  // `brew shellenv` and `nvm.sh`), and the session's own markers. Homebrew's
  // credential, `HOMEBREW_GITHUB_API_TOKEN`, is not named here.
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY',
  'NVM_DIR',
  'NVM_BIN',
  'NVM_INC',
  'COMMAND_MODE',
  '__CF_USER_TEXT_ENCODING',
  '__CFBundleIdentifier',
])

/**
 * The host values that must never appear in cell output: every variable the
 * allowlist dropped, other than the well-known non-secret ones above, when it
 * is long enough to be a credential rather than a flag. Fed to the secret
 * redactor as literal secrets so a leak the backend could not prevent still
 * never reaches a finding. A value is exempt only under an exempt name: if any
 * other dropped variable carries the same value, it stays a secret.
 */
export function droppedHostSecrets(
  hostEnv: Readonly<Record<string, string | undefined>>,
): string[] {
  const allowed = new Set<string>(CELL_ENV_ALLOWLIST)
  const secrets: string[] = []
  for (const [key, value] of Object.entries(hostEnv)) {
    if (allowed.has(key) || NON_SECRET_HOST_VARIABLES.has(key) || value === undefined) continue
    if (value.trim().length < 8) continue
    secrets.push(value)
  }
  return secrets
}

/**
 * A view of a cell that runs one command at a time. Reviewers that fan out
 * share one head checkout, and two test runs in one working directory would
 * trample each other's build output; the plan's per-reviewer worktrees are
 * the full answer, and a queue is the Phase 2 stand-in that keeps the shared
 * checkout coherent at the cost of parallel execution inside the cell.
 */
export function serializeCell(cell: ExecutionCell): ExecutionCell {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    spec: cell.spec,
    run(command: CellCommand): Promise<CellCommandResult> {
      const next = tail.then(() => {
        command.signal?.throwIfAborted()
        return cell.run(command)
      })
      tail = next.catch(() => undefined)
      return next
    },
    destroy: () => cell.destroy(),
  }
}
