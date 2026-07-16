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

/** Thrown when the active project is remote but execution cannot route over SSH. */
export class ExecutionTargetMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionTargetMismatchError'
  }
}

/** Whether SSH workspace execution is enabled (experimental, default off). */
export function isSshWorkspaceExecutionEnabled(): boolean {
  return getSetting<boolean>('sshWorkspaceEnabled', false)
}

function findActiveStoredProject(): StoredProject | null {
  const activeProjectId = storageGet('activeProjectId')
  if (typeof activeProjectId !== 'string') return null

  const projects = storageGet('projects')
  if (!Array.isArray(projects)) return null

  const active = projects.find((project): project is StoredProject => {
    if (!project || typeof project !== 'object') return false
    const candidate = project as StoredProject
    return candidate.id === activeProjectId && typeof candidate.path === 'string'
  })
  return active ?? null
}

/**
 * Resolve the execution target for the active project. Returns `local` for
 * local projects. Remote projects fail closed when SSH execution is disabled
 * or the host is missing from settings — never silently fall back to local.
 */
export function getActiveExecutionTarget(): ExecutionTarget {
  const active = findActiveStoredProject()
  if (!active?.sshHost) return { kind: 'local' }

  if (!isSshWorkspaceExecutionEnabled()) {
    throw new ExecutionTargetMismatchError(
      'SSH workspaces are disabled. Enable them in Settings to use this remote project.',
    )
  }

  const host = findConfiguredSshHost(active.sshHost)
  if (!host) {
    throw new ExecutionTargetMismatchError(
      `SSH host "${active.sshHost}" is not configured. Add it in Settings → SSH.`,
    )
  }

  const root = getWorkspaceRoot()
  if (!root) return { kind: 'local' }

  return { kind: 'ssh', hostId: host.id, remoteRoot: root }
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
  try {
    return isSshExecutionTarget(getActiveExecutionTarget())
  } catch {
    return false
  }
}
