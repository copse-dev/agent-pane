import { basename, dirname } from 'node:path'
import { posixQuote } from '../services/security/safe-install.ts'

/**
 * Pure argv/env helpers for wrapping a command with ASRT.
 *
 * Split out of `spawn.ts` as a leaf so a standalone worker bundle can wrap and
 * spawn a sandboxed child without dragging in `spawn.ts`'s `node-pty` import —
 * the native module fails to load outside the packaged app, which would take the
 * whole bundle down at require time. `spawn.ts` re-exports everything here, so
 * existing importers are unaffected.
 */

/**
 * POSIX-only: run the child as its own process-group leader so the group can be killed together.
 * Exported so every long-lived sandboxed child (ACP agents included) detaches the same way —
 * `terminateProcessTree` can only reach grandchildren when the child leads a group.
 */
export const detachForGroupKill = process.platform !== 'win32'

const DEFAULT_SANDBOX_SHELL = '/bin/bash'

function ensurePathIncludes(dirs: string[]): void {
  if (process.platform === 'win32') return
  const current = process.env['PATH'] ?? ''
  const seen = new Set(current.split(':').filter(Boolean))
  const missing = dirs.filter((dir) => !seen.has(dir))
  if (missing.length > 0) {
    process.env['PATH'] = [...missing, current].filter(Boolean).join(':')
  }
}

/** Join argv for `/bin/sh -c` / ASRT wrap. Uses POSIX single quotes so paths with spaces stay one word. */
export function formatArgvForShell(executable: string, args: string[]): string {
  return [executable, ...args].map(posixQuote).join(' ')
}

/**
 * ASRT returns a bare shell name (`bash`) as argv[0]. GUI Electron apps often
 * have a PATH that omits `/bin`, so spawn('bash') → ENOENT. Keep the bare name
 * for ASRT, but rewrite to an absolute path at spawn time.
 */
export function resolveSandboxShellExecutable(file: string): string {
  if (process.platform === 'win32' || file.includes('/')) return file
  if (file === 'bash') return '/bin/bash'
  if (file === 'sh') return '/bin/sh'
  return file
}

/** Ensure the child env can resolve `/bin` shells even when opts.env was snapshotted earlier. */
export function withSandboxShellPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return env
  const required = ['/usr/bin', '/bin']
  const parts = (env['PATH'] ?? '').split(':').filter(Boolean)
  const missing = required.filter((dir) => !parts.includes(dir))
  if (missing.length === 0) return env
  return { ...env, PATH: [...missing, ...parts].join(':') }
}

export function shellForSandboxWrap(shellPath: string = DEFAULT_SANDBOX_SHELL): string {
  if (process.platform === 'win32' || !shellPath.includes('/')) return shellPath
  ensurePathIncludes([dirname(shellPath), '/usr/bin', '/bin'])
  return basename(shellPath)
}
