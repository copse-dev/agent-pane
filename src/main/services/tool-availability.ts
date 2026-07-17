import { runCommand } from './exec/command-runner.ts'
import { probeIndexedGrepBackends } from './search/indexed-grep.ts'
import { isSemanticBackendBundled, probeSemanticBackends } from './search/semantic-index.ts'
import type { ExecutionTarget } from './ssh-workspace/execution-target.ts'
import {
  getActiveExecutionTarget,
  isSshExecutionTarget,
  isSshWorkspaceExecutionEnabled,
} from './ssh-workspace/execution-target.ts'
import { getSshConnectionManager } from './ssh-workspace/connection-manager.ts'

let rgAvail: boolean | null = null
let gitAvail: boolean | null = null
let ghAvail: boolean | null = null

export async function checkToolAvailability(): Promise<void> {
  // The e2e app relaunches Electron once per spec (~47×/full run); these probes
  // run before the window opens on every launch. Under e2e, skip them: ripgrep
  // and git are provisioned in the e2e environment, so assume them present (the
  // git-changes and search specs rely on it), while gh and the indexed-grep /
  // semantic-backend probes (a spawned gortex binary) are unused by the
  // seeded suite, so leave them off rather than spawning anything.
  if (process.env['COPSE_E2E'] === '1') {
    rgAvail = true
    gitAvail = true
    ghAvail = false
    return
  }
  rgAvail = await probe('rg', ['--version'])
  gitAvail = await probe('git', ['--version'])
  ghAvail = await probeGhAccessible()
  const grepBackend = await probeIndexedGrepBackends()
  const semanticBackend = await probeSemanticBackends()
  if (!rgAvail)
    console.warn('[copse-panel] ripgrep (rg) not found — search_code will use slow fallback')
  else if (grepBackend !== 'rg')
    console.info(`[copse-panel] search_code will prefer indexed grep backend: ${grepBackend}`)
  if (semanticBackend)
    console.info(
      `[copse-panel] semantic search will use native backend: ${semanticBackend}` +
        (isSemanticBackendBundled() ? ' (bundled)' : ''),
    )
  else
    console.warn(
      '[copse-panel] gortex/vera not found — semantic search disabled (run npm install or add CLI to PATH)',
    )
  if (!gitAvail) console.warn('[copse-panel] git not found — git tools will be unavailable')
  if (!ghAvail)
    console.warn(
      '[copse-panel] gh not found or not authenticated — GitHub read-only tools will be unavailable',
    )
}

export const isRgAvailable = (): boolean => rgAvail === true
export const isGitAvailable = (): boolean => gitAvail === true
export const isGhAvailable = (): boolean => ghAvail === true

/**
 * Whether git is available for the active (or given) execution target. Local
 * workspaces use the startup PATH probe; SSH workspaces use the connection
 * capability report (remote git on the host).
 */
export async function isGitAvailableForTarget(
  target: ExecutionTarget = getActiveExecutionTarget(),
): Promise<boolean> {
  if (!isSshExecutionTarget(target)) return isGitAvailable()
  if (!isSshWorkspaceExecutionEnabled()) return false
  const mgr = getSshConnectionManager()
  const existing = mgr.getConnection(target.hostId)
  if (existing?.capabilities) return existing.capabilities.git
  try {
    const conn = await mgr.connect(target.hostId)
    return conn.capabilities?.git ?? false
  } catch {
    return false
  }
}

/**
 * Whether ripgrep is available for the active (or given) execution target. Local
 * workspaces use the startup PATH probe; SSH workspaces use the connection
 * capability report (remote rg on the host).
 */
export async function isRgAvailableForTarget(
  target: ExecutionTarget = getActiveExecutionTarget(),
): Promise<boolean> {
  if (!isSshExecutionTarget(target)) return isRgAvailable()
  if (!isSshWorkspaceExecutionEnabled()) return false
  const mgr = getSshConnectionManager()
  const existing = mgr.getConnection(target.hostId)
  if (existing?.capabilities) return existing.capabilities.rg
  try {
    const conn = await mgr.connect(target.hostId)
    return conn.capabilities?.rg ?? false
  } catch {
    return false
  }
}

/** Test hook — force ripgrep availability without probing PATH. */
export function setRgAvailableForTest(value: boolean | null): void {
  rgAvail = value
}

/** Test hook — force git availability without probing PATH. */
export function setGitAvailableForTest(value: boolean | null): void {
  gitAvail = value
}

/** Test hook — force gh availability without probing PATH. */
export function setGhAvailableForTest(value: boolean | null): void {
  ghAvail = value
}

function probePathPrefix(): string {
  return process.platform === 'win32' ? '' : '/usr/bin:/bin:/exec-daemon:'
}

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(cmd, args, {
      env: { PATH: `${probePathPrefix()}${process.env['PATH'] ?? ''}` },
    })
    return true
  } catch {
    return false
  }
}

/**
 * Deterministically decide whether the GitHub read-only tools should be exposed.
 *
 * `gh --version` only proves the binary is installed; a `gh` that can't reach an
 * authenticated GitHub host would still pass that probe, then every read-only GH
 * tool call would fail at runtime. So we instead run `gh auth status`, which exits
 * non-zero when no host is logged in or the token is invalid. runCommand resolves
 * (rather than throwing) on a non-zero exit, so we inspect the exit code directly:
 * a missing binary rejects, anything but a clean `code === 0` means GitHub is not
 * accessible. This keeps the gh_pr_* / read-only CI tools hidden from the model
 * unless GitHub is genuinely accessible — see issue #523.
 */
async function probeGhAccessible(): Promise<boolean> {
  try {
    const { code } = await runCommand('gh', ['auth', 'status'], {
      env: { PATH: `${probePathPrefix()}${process.env['PATH'] ?? ''}` },
    })
    return code === 0
  } catch {
    return false
  }
}
