import { storageGet } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import {
  getWorkspaceRoot,
  normalizeRemoteWorkspacePath,
  resolveSshHostForWorkspaceRoot,
} from '../workspace.ts'
import { findConfiguredSshHost } from './hosts.ts'
import { currentThreadExecutionContext } from '../thread-execution-context-store.ts'
import { isRecord } from '@shared/unknown-value.ts'

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
  return findStoredProject(activeProjectId)
}

function findStoredProject(projectId: string): StoredProject | null {
  const projects = storageGet('projects')
  if (!Array.isArray(projects)) return null

  const found = projects.find((project): project is StoredProject => {
    return isRecord(project) && project['id'] === projectId && typeof project['path'] === 'string'
  })
  return found ?? null
}

/**
 * The execution target of the project the current agent turn belongs to, or
 * null outside a turn or for a turn whose project is not persisted (headless
 * runs). A turn keeps its own project's placement when the user switches the
 * window to another project, so a command authorized as locally contained
 * cannot be routed to an SSH host that became active before it spawned. Fails
 * closed exactly like {@link getActiveExecutionTarget} for an unroutable remote.
 */
export function threadProjectExecutionTarget(): ExecutionTarget | null {
  const context = currentThreadExecutionContext()
  if (!context) return null
  const project = findStoredProject(context.projectId)
  if (!project) return null
  const sshHost = project.sshHost
  if (typeof sshHost !== 'string') return { kind: 'local' }
  if (!isSshWorkspaceExecutionEnabled()) {
    throw new ExecutionTargetMismatchError(
      'SSH workspaces are disabled. Enable them in Settings to use this remote project.',
    )
  }
  const host = findConfiguredSshHost(sshHost)
  if (!host) {
    throw new ExecutionTargetMismatchError(
      `SSH host "${sshHost}" is not configured. Add it in Settings → Machines.`,
    )
  }
  return {
    kind: 'ssh',
    hostId: host.id,
    remoteRoot: normalizeRemoteWorkspacePath(project.path),
  }
}

function findStoredProjectPathForHost(sshHost: string): string | undefined {
  const projects = storageGet('projects')
  if (!Array.isArray(projects)) return undefined
  for (const project of projects) {
    if (!isRecord(project)) continue
    if (project['sshHost'] === sshHost && typeof project['path'] === 'string') {
      return project['path']
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
      `SSH host "${sshHost}" is not configured. Add it in Settings → Machines.`,
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

export const isSshExecutionTarget: (
  target: ExecutionTarget,
) => target is Extract<ExecutionTarget, { kind: 'ssh' }> = (target) => target.kind === 'ssh'

/** True when the active project routes shell/fs/git through an SSH workspace. */
export function isActiveSshWorkspace(): boolean {
  try {
    return isSshExecutionTarget(getActiveExecutionTarget())
  } catch {
    return false
  }
}
