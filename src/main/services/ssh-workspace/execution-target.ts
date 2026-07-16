import { storageGet } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import {
  getWorkspaceRoot,
  normalizeRemoteWorkspacePath,
  resolveSshHostForWorkspaceRoot,
} from '../workspace.ts'
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

function findStoredProjectPathForHost(sshHost: string): string | undefined {
  const projects = storageGet('projects')
  if (!Array.isArray(projects)) return undefined
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue
    const candidate = project as StoredProject
    if (candidate.sshHost === sshHost && typeof candidate.path === 'string') {
      return candidate.path
    }
  }
  return undefined
}

/**
 * Resolve the execution target for the active project. Returns `local` for
 * local projects. Remote projects fail closed when SSH execution is disabled
 * or the host is missing from settings — never silently fall back to local.
 */
export function getActiveExecutionTarget(): ExecutionTarget {
  const active = findActiveStoredProject()
  const workspaceRoot = getWorkspaceRoot()
  // Prefer the active project's sshHost, then any project whose path matches the
  // workspace root (covers races where activeProjectId lags workspace:set).
  const sshHost =
    (typeof active?.sshHost === 'string' ? active.sshHost : undefined) ??
    (workspaceRoot ? resolveSshHostForWorkspaceRoot(workspaceRoot) : undefined)

  if (!sshHost) return { kind: 'local' }

  if (!isSshWorkspaceExecutionEnabled()) {
    throw new ExecutionTargetMismatchError(
      'SSH workspaces are disabled. Enable them in Settings to use this remote project.',
    )
  }

  const host = findConfiguredSshHost(sshHost)
  if (!host) {
    throw new ExecutionTargetMismatchError(
      `SSH host "${sshHost}" is not configured. Add it in Settings → SSH.`,
    )
  }

  const remoteRoot =
    (active?.sshHost === sshHost ? active.path : undefined) ??
    workspaceRoot ??
    findStoredProjectPathForHost(sshHost)
  if (!remoteRoot) {
    throw new ExecutionTargetMismatchError(
      `Remote workspace root is not set for SSH host "${sshHost}".`,
    )
  }

  return {
    kind: 'ssh',
    hostId: host.id,
    remoteRoot: normalizeRemoteWorkspacePath(remoteRoot),
  }
}

/**
 * Resolve an SSH target for a cwd that belongs to a remote project even when the
 * active execution target incorrectly resolved to local (activation races).
 */
export function resolveSshExecutionTargetForCwd(cwd: string): ExecutionTarget | null {
  const sshHost = resolveSshHostForWorkspaceRoot(cwd)
  if (!sshHost) return null
  if (!isSshWorkspaceExecutionEnabled()) return null
  const host = findConfiguredSshHost(sshHost)
  if (!host) return null
  const active = findActiveStoredProject()
  const remoteRoot =
    (active?.sshHost === sshHost ? active.path : undefined) ??
    findStoredProjectPathForHost(sshHost) ??
    cwd
  return {
    kind: 'ssh',
    hostId: host.id,
    remoteRoot: normalizeRemoteWorkspacePath(remoteRoot),
  }
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
