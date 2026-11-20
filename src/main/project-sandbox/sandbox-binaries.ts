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
export function linuxSandboxBinaryPaths(): { bwrapPath?: string; socatPath?: string } {
  if (process.platform !== 'linux') return {}
  return { bwrapPath: resolveSandboxBinary('bwrap'), socatPath: resolveSandboxBinary('socat') }
}
