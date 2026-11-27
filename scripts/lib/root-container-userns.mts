// Run test launchers as an unprivileged user inside root Linux containers.
//
// Cloud agent containers (Claude Code cloud sessions, Cursor Cloud) run as
// uid 0. As root, the project sandbox's bubblewrap invocation starts and then
// fails every command with `apply-seccomp: write /proc/self/uid_map: Operation
// not permitted`, so sandbox tests and e2e approval specs fail in ways that look
// like product bugs. The same invocation works as an ordinary user, so the
// launchers re-execute themselves inside a user namespace that maps uid 1000
// to the caller: files owned by root stay writable, and bubblewrap sees a
// normal user. See docs/agent-development.md ("Claude Code cloud sessions").
//
// Only root on Linux is affected. CI runners and developer machines are not
// root and never re-execute.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { accessSync, constants } from 'node:fs'
import { constants as osConstants } from 'node:os'

/** Set inside the namespace so the child does not re-execute again. `0` opts out. */
export const ROOT_USERNS_ENV = 'COPSE_ROOT_USERNS'

const NAMESPACE_ARGS = ['-U', '--map-user=1000', '--map-group=1000', '--'] as const

/** Packages the project sandbox needs on Linux, by the binary each provides. */
const SANDBOX_BINARIES = [
  { binary: 'bwrap', pkg: 'bubblewrap' },
  { binary: 'socat', pkg: 'socat' },
] as const

export interface RootUsernsHost {
  readonly platform: NodeJS.Platform
  readonly uid: number | undefined
  readonly env: NodeJS.ProcessEnv
  /** Whether `binary` resolves on PATH. */
  readonly hasBinary: (binary: string) => boolean
  /** Runs `unshare … -- true`; true when a user namespace can be created. */
  readonly canUnshare: () => boolean
}

export type RootUsernsPlan =
  | { readonly kind: 'run-here' }
  | { readonly kind: 'reexec' }
  | { readonly kind: 'blocked'; readonly reason: string }

/**
 * Decide how a launcher should start on this host.
 *
 * `requireSandbox` launchers (e2e) refuse to start when the sandbox cannot
 * work, because their specs would pass or fail on fallback copy instead. Unit
 * launchers still run: tests that need the sandbox skip or fail naming it.
 */
export function planRootUserns(
  host: RootUsernsHost,
  options: { readonly requireSandbox: boolean },
): RootUsernsPlan {
  if (host.platform !== 'linux' || host.uid !== 0) return { kind: 'run-here' }
  const setting = host.env[ROOT_USERNS_ENV]
  if (setting === '1' || setting === '0') return { kind: 'run-here' }

  const missing = SANDBOX_BINARIES.filter(({ binary }) => !host.hasBinary(binary)).map(
    ({ pkg }) => pkg,
  )
  if (missing.length > 0) {
    if (!options.requireSandbox) return { kind: 'run-here' }
    return {
      kind: 'blocked',
      reason:
        `the project sandbox needs ${missing.join(' and ')}, which ${missing.length === 1 ? 'is' : 'are'} not installed. ` +
        `Install with: apt-get install -y --no-install-recommends ${missing.join(' ')} ` +
        `(or run bash .claude/cloud-setup.sh)`,
    }
  }
  if (!host.canUnshare()) {
    if (!options.requireSandbox) return { kind: 'run-here' }
    return {
      kind: 'blocked',
      reason:
        'running as root, where the project sandbox cannot apply its seccomp filter, and ' +
        '`unshare -U --map-user=1000 --map-group=1000` failed: either user namespaces are ' +
        'unavailable or this util-linux `unshare` predates --map-user. ' +
        'Run as a non-root user instead.',
    }
  }
  return { kind: 'reexec' }
}

function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, binary), constants.X_OK)
      return true
    } catch {
      // Not in this directory.
    }
  }
  return false
}

function currentRootUsernsHost(): RootUsernsHost {
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    env: process.env,
    hasBinary: (binary) => onPath(binary, process.env),
    canUnshare: () =>
      spawnSync('unshare', [...NAMESPACE_ARGS, 'true'], { stdio: 'ignore' }).status === 0,
  }
}

/**
 * Exit the way the child did. Re-raising its signal does not end this process
 * when Node ignores or handles that signal (SIGPIPE by default), so exit with
 * the shell's 128 + signal status after it; returning would run the launcher a
 * second time, as root.
 */
export function exitLike(result: SpawnSyncReturns<Buffer>): never {
  if (result.error) throw result.error
  if (result.signal) {
    process.kill(process.pid, result.signal)
    process.exit(128 + osConstants.signals[result.signal])
  }
  process.exit(result.status ?? 1)
}

/**
 * Re-execute the current script as uid 1000 in a user namespace when it runs
 * as root on Linux, and exit with the child's status. Returns when the script
 * should carry on in this process. Exits 1 with a message when a
 * `requireSandbox` launcher cannot get a working sandbox.
 */
export function reexecOutsideRootIfNeeded(
  label: string,
  options: { readonly requireSandbox: boolean },
): void {
  const plan = planRootUserns(currentRootUsernsHost(), options)
  if (plan.kind === 'run-here') return
  if (plan.kind === 'blocked') {
    console.error(`[${label}] Not starting: ${plan.reason}`)
    console.error(`[${label}] Set ${ROOT_USERNS_ENV}=0 to run as root anyway.`)
    process.exit(1)
  }
  console.error(
    `[${label}] running as root: re-executing as uid 1000 in a user namespace so the project sandbox works ` +
      `(set ${ROOT_USERNS_ENV}=0 to stay root)`,
  )
  const result = spawnSync(
    'unshare',
    [...NAMESPACE_ARGS, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, [ROOT_USERNS_ENV]: '1' } },
  )
  exitLike(result)
}
