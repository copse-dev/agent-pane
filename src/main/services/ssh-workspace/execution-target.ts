import { storageGet } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { findConfiguredSshHost } from './hosts.ts'

export type ExecutionTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; hostId: string; remoteRoot: string }

interface StoredProject {
  id: string
  path: string
  sshHost?: string
}

/** Whether SSH workspace execution is enabled (experimental, default off). */
export function isSshWorkspaceExecutionEnabled(): boolean {
  return getSetting<boolean>('sshWorkspaceEnabled', false)
}

/**
 * Resolve the execution target for the active project. Returns `local` when
 * execution is disabled, the project has no `sshHost`, or the host is unknown.
 */
export function getActiveExecutionTarget(): ExecutionTarget {
  if (!isSshWorkspaceExecutionEnabled()) return { kind: 'local' }

  const root = getWorkspaceRoot()
  if (!root) return { kind: 'local' }

  const activeProjectId = storageGet('activeProjectId')
  if (typeof activeProjectId !== 'string') return { kind: 'local' }

  const projects = storageGet('projects')
  if (!Array.isArray(projects)) return { kind: 'local' }

  const active = projects.find((project): project is StoredProject => {
    if (!project || typeof project !== 'object') return false
    const candidate = project as StoredProject
    return candidate.id === activeProjectId && typeof candidate.path === 'string'
  })
  if (!active?.sshHost) return { kind: 'local' }

  const host = findConfiguredSshHost(active.sshHost)
  if (!host) return { kind: 'local' }

  return { kind: 'ssh', hostId: host.id, remoteRoot: active.path }
}

export function resolveExecutionTarget(explicit: ExecutionTarget | undefined): ExecutionTarget {
  return explicit ?? getActiveExecutionTarget()
}

export function isSshExecutionTarget(
  target: ExecutionTarget,
): target is Extract<ExecutionTarget, { kind: 'ssh' }> {
  return target.kind === 'ssh'
}

/** True when the active project routes shell/fs/git through an SSH workspace. */
export function isActiveSshWorkspace(): boolean {
  return isSshWorkspaceExecutionEnabled() && isSshExecutionTarget(getActiveExecutionTarget())
}
