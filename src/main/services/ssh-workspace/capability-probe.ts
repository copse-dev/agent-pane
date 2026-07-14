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
  const [osResult, archResult, shellResult] = await Promise.all([
    transport.execArgv(['uname', '-s'], { timeoutMs: PROBE_TIMEOUT_MS }),
    transport.execArgv(['uname', '-m'], { timeoutMs: PROBE_TIMEOUT_MS }),
    transport.execShell('printf %s "$SHELL"', { timeoutMs: PROBE_TIMEOUT_MS }),
  ])

  const git = await hasTool(transport, 'git')
  const rg = await hasTool(transport, 'rg')
  const inotifywait = await hasTool(transport, 'inotifywait')

  const warnings: string[] = []
  if (osResult.code !== 0 || archResult.code !== 0) {
    warnings.push('Capability probe command failed — remote tooling may be unavailable.')
  }
  if (!git) warnings.push('`git` missing on host — git pane and backups will not work remotely.')
  if (!rg) warnings.push('`rg` missing on host — searches will fall back to `grep -r`.')
  if (!inotifywait) {
    warnings.push('`inotifywait` missing — external file edits may not be detected live.')
  }

  return {
    os: osResult.stdout.trim() || 'unknown',
    arch: archResult.stdout.trim() || 'unknown',
    shell: shellResult.stdout.trim() || null,
    git,
    rg,
    inotifywait,
    warnings,
  }
}
