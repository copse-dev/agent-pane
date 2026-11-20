import type { SshCapabilityReport, SshExecResult } from '@shared/types/ssh-workspace.ts'
import type { SshTransport } from './transport.ts'

const PROBE_TIMEOUT_MS = 15_000

async function hasTool(transport: SshTransport, name: string): Promise<boolean> {
  const result = await transport.execShell(`command -v ${name}`, { timeoutMs: PROBE_TIMEOUT_MS })
  return toolPresent(result)
}

function toolPresent(result: SshExecResult): boolean {
  return result.code === 0 && result.stdout.trim().length > 0
}

export async function probeSshCapabilities(transport: SshTransport): Promise<SshCapabilityReport> {
  const [osResult, archResult, shellResult, homeResult] = await Promise.all([
    transport.execArgv(['uname', '-s'], { timeoutMs: PROBE_TIMEOUT_MS }),
    transport.execArgv(['uname', '-m'], { timeoutMs: PROBE_TIMEOUT_MS }),
    transport.execShell('printf %s "$SHELL"', { timeoutMs: PROBE_TIMEOUT_MS }),
    transport.execShell('printf %s "$HOME"', { timeoutMs: PROBE_TIMEOUT_MS }),
  ])

  const git = await hasTool(transport, 'git')
  const rg = await hasTool(transport, 'rg')

  // Tool presence is carried by the boolean flags; the status banner turns those
  // into user-facing copy. Keep `warnings` for probe/infrastructure failures only
  // so the UI does not show the same missing-tool message twice.
  const warnings: string[] = []
  if (osResult.code !== 0 || archResult.code !== 0) {
    warnings.push('Checking the remote machine failed — remote tools may be unavailable.')
  }

  const home = remoteHomeDirectory(homeResult)
  return {
    os: osResult.stdout.trim() || 'unknown',
    arch: archResult.stdout.trim() || 'unknown',
    shell: shellResult.stdout.trim() || null,
    ...(home === null ? {} : { home }),
    git,
    rg,
    warnings,
  }
}

/**
 * The home directory a probe printed, or null. Only a single-line absolute
 * POSIX path is believed: it becomes where the folder browser starts, so a
 * relative or multi-line answer (a login banner, an unset `$HOME`) is dropped
 * rather than guessed at.
 */
export function remoteHomeDirectory(result: SshExecResult): string | null {
  if (result.code !== 0) return null
  const home = result.stdout.trim()
  if (!home.startsWith('/') || /[\n\r\0]/.test(home)) return null
  return home.length > 1 ? home.replace(/\/+$/, '') : home
}
