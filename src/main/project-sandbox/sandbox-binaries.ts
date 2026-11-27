import { getApplySeccompBinaryPath } from '@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js'
import { getJavaProxyAgentJarPath } from '@anthropic-ai/sandbox-runtime/dist/sandbox/java-proxy-agent.js'
import { accessSync, constants, statSync } from 'node:fs'
import { posix } from 'node:path'
import { absolutePathEntries } from './sandbox-argv.ts'

/** Where Linux distributions install bubblewrap and socat; searched before `PATH`. */
const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin'] as const

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The absolute path ASRT should launch `name` from: the first executable copy
 * in the system bin directories, then in the absolute entries of `pathValue`.
 * Relative and empty entries are never searched, so the answer does not depend
 * on any working directory.
 *
 * With no copy anywhere this still names `/usr/bin/<name>`. ASRT's dependency
 * check then reports it missing and the sandbox does not start, the same
 * failure as an uninstalled binary, instead of falling back to a bare name.
 */
export function resolveSandboxBinary(
  name: string,
  pathValue: string | undefined = process.env['PATH'],
  isExecutable: (path: string) => boolean = isExecutableFile,
): string {
  for (const dir of [...SYSTEM_BIN_DIRS, ...absolutePathEntries(pathValue)]) {
    const candidate = posix.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return posix.join(SYSTEM_BIN_DIRS[0], name)
}

/**
 * ASRT's Linux helpers by absolute path, for every config Copse initializes
 * ASRT with and for worktree preparation's direct Linux wrap. Unset, ASRT
 * names a bare `bwrap` as the first word of each wrapped command and a bare
 * `socat` inside the namespace, both resolved through the spawn's `PATH`.
 * Resolved once per initialization. macOS has no such option: there the
 * wrapper's lookup searches only the absolute `PATH` entries that
 * `withSandboxShellPath` keeps.
 */
export function linuxSandboxBinaryPaths(): {
  bwrapPath?: string
  socatPath?: string
  seccomp?: { applyPath: string }
  javaAgentJarPath?: string
} {
  if (process.platform !== 'linux') return {}
  const applyPath = sandboxHelperLocator.applySeccompPath()
  const javaAgentJarPath = sandboxHelperLocator.javaAgentJarPath()
  return {
    bwrapPath: resolveSandboxBinary('bwrap'),
    socatPath: resolveSandboxBinary('socat'),
    ...(applyPath === null ? {} : { seccomp: { applyPath } }),
    ...(javaAgentJarPath === null ? {} : { javaAgentJarPath }),
  }
}

/**
 * The same launcher paths shaped for a direct `wrapCommandWithSandboxLinux`
 * call, which bypasses SandboxManager. That wrapper reads `seccompConfig`, not
 * the config's `seccomp`, and a spread drops the wrong key without a type
 * error. It sets no proxy sockets, so the JVM agent jar does not apply.
 */
export function linuxWrapperBinaryPaths(): {
  bwrapPath?: string
  socatPath?: string
  seccompConfig?: { applyPath: string }
} {
  const { bwrapPath, socatPath, seccomp } = linuxSandboxBinaryPaths()
  return {
    ...(bwrapPath === undefined ? {} : { bwrapPath }),
    ...(socatPath === undefined ? {} : { socatPath }),
    ...(seccomp === undefined ? {} : { seccompConfig: seccomp }),
  }
}

/**
 * Where `linuxSandboxBinaryPaths` finds ASRT's helpers. An object so a test
 * can substitute a path that differs from ASRT's own module-relative lookup,
 * which in a dev install is the same file.
 */
export const sandboxHelperLocator = {
  applySeccompPath: (): string | null => applySeccompBinaryPath(),
  javaAgentJarPath: (): string | null => javaProxyAgentJarPath(),
}

const ASAR_SEGMENT = '/app.asar/'
const UNPACKED_ASAR_SEGMENT = '/app.asar.unpacked/'

/**
 * The on-disk spelling of a path that Electron's fs shim reports inside
 * `app.asar`. Reads through the shim succeed, but bubblewrap execs the path
 * itself, and a file inside an archive is "Not a directory" to the kernel.
 * electron-builder's `asarUnpack` puts the real copy in `app.asar.unpacked`.
 */
export function unpackedAsarPath(path: string): string {
  const at = path.lastIndexOf(ASAR_SEGMENT)
  if (at === -1) return path
  return `${path.slice(0, at)}${UNPACKED_ASAR_SEGMENT}${path.slice(at + ASAR_SEGMENT.length)}`
}

/**
 * ASRT's apply-seccomp helper as an executable path, or null where ASRT has
 * none (macOS, unsupported architectures). Left to itself, ASRT finds the
 * helper next to its own module, which in a packaged Linux app is inside
 * `app.asar`, so every sandboxed command fails with exit 126.
 */
export function applySeccompBinaryPath(
  found: string | null = process.platform === 'linux' ? getApplySeccompBinaryPath() : null,
): string | null {
  return found === null ? null : unpackedAsarPath(found)
}

/**
 * ASRT's JVM proxy agent jar on disk, or null where ASRT ships none. Like
 * apply-seccomp, ASRT finds it beside its own module, inside `app.asar` in a
 * packaged app, and bubblewrap then fails to bind that source path whenever
 * the jar sits under a denied root such as `$HOME`.
 */
export function javaProxyAgentJarPath(
  found: string | null = getJavaProxyAgentJarPath(),
): string | null {
  return found === null ? null : unpackedAsarPath(found)
}
