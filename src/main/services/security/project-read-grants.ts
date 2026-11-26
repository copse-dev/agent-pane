import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPathWithin } from '@copse/std/path-containment.ts'
import {
  MAX_SANDBOX_READ_FOLDERS_PER_PROJECT,
  SANDBOX_READ_PROJECT_FOLDERS_SETTING,
} from '@shared/sandbox-read-access.ts'
import {
  approvedFolderStillSafe,
  sandboxReadAccessPolicy,
} from '../../project-sandbox/sandbox-read-access.ts'
import { getSetting, updateSetting } from '../storage/settings.ts'
import { isLiteralPath } from './literal-path.ts'
import { currentThreadExecutionContext } from '../thread-execution-context-store.ts'
import { getExplicitWorkspaceRoot } from '../workspace.ts'

/**
 * Folders outside a project that its sandboxed commands may read, approved
 * once through "Allow read access outside of the project?" and kept across
 * restarts (Settings → Permissions → Sandbox read access).
 *
 * Keyed by project root, like remembered port binding (`project-port-grants.ts`),
 * so every thread worktree of the project shares them and no other project
 * sees them. Each entry is the folder's canonical path at approval time. A
 * folder whose realpath has since moved, or that now covers a credential
 * store, is skipped by {@link projectReadFolders} until approved again; it is
 * never re-resolved to wherever it now points.
 *
 * Reads only. The sandbox overlay adds each folder to `allowRead` with its
 * credential files denied inside it, and the shell-scope classifier treats a
 * read-only command naming one as contained.
 */
type FolderMap = Record<string, string[]>

function stored(): FolderMap {
  return getSetting<FolderMap>(SANDBOX_READ_PROJECT_FOLDERS_SETTING, {})
}

/** Every stored folder for `projectRoot`, including ones that would now be skipped. */
export function storedProjectReadFolders(projectRoot: string | null): string[] {
  if (projectRoot === null) return []
  const folders = stored()[resolve(projectRoot)]
  return Array.isArray(folders) ? [...folders] : []
}

/** The stored folders still safe to grant, as canonical paths. */
export function projectReadFolders(projectRoot: string | null): string[] {
  return storedProjectReadFolders(projectRoot).filter((folder) => approvedFolderStillSafe(folder))
}

/** Whether `projectRoot` can take `count` more folders without passing the cap. */
export function projectReadFolderCapacity(projectRoot: string, count: number): boolean {
  const existing = new Set(storedProjectReadFolders(projectRoot))
  return existing.size + count <= MAX_SANDBOX_READ_FOLDERS_PER_PROJECT
}

/** Persist canonical folders for a project. Returns the folders newly added. */
export async function rememberProjectReadFolders(
  projectRoot: string,
  canonicalFolders: readonly string[],
): Promise<string[]> {
  const key = resolve(projectRoot)
  const added: string[] = []
  await updateSetting<FolderMap>(SANDBOX_READ_PROJECT_FOLDERS_SETTING, {}, (current) => {
    const existing = current[key] ?? []
    const next = [...existing]
    added.length = 0
    for (const folder of canonicalFolders) {
      if (next.includes(folder) || next.length >= MAX_SANDBOX_READ_FOLDERS_PER_PROJECT) continue
      next.push(folder)
      added.push(folder)
    }
    return { ...current, [key]: next }
  })
  return added
}

/** Remove one folder from a project. Affects the next command; a running one keeps its sandbox. */
export async function revokeProjectReadFolder(projectRoot: string, folder: string): Promise<void> {
  const key = resolve(projectRoot)
  await updateSetting<FolderMap>(SANDBOX_READ_PROJECT_FOLDERS_SETTING, {}, (current) => {
    const remaining = (current[key] ?? []).filter((candidate) => candidate !== folder)
    const others = Object.fromEntries(Object.entries(current).filter(([root]) => root !== key))
    return remaining.length === 0 ? others : { ...others, [key]: remaining }
  })
}

/**
 * Whether the project's approved folders already cover every canonical
 * target, so the read prompt need not ask. False when the group is off.
 */
export function projectReadFoldersCover(
  projectRoot: string | null,
  resolvedTargets: readonly string[],
  canonicalTargets: readonly string[],
): boolean {
  if (canonicalTargets.length === 0 || canonicalTargets.length !== resolvedTargets.length)
    return false
  if (!sandboxReadAccessPolicy().approvedFolders) return false
  // The shell expands a token only after the gate decides, so `dir/{..,x}/f`
  // sits under `dir` as text but reads `dir/../f`: only literal tokens count.
  if (!resolvedTargets.every((target) => isLiteralPath(resolve(target)))) return false
  const folders = projectReadFolders(projectRoot)
  return canonicalTargets.every((target) => folders.some((folder) => isPathWithin(folder, target)))
}

/**
 * The folders a read prompt may offer to remember for the project, or null
 * when it must offer only the thread grant: the group is off, there is no
 * project, a target is not an existing directory, the credential guard
 * refuses one (home, an ancestor of home, a folder that holds or sits in a
 * credential store), or the project is at its cap.
 */
export function projectReadFolderOffer(
  projectRoot: string | null,
  canonicalTargets: readonly string[],
): string[] | null {
  if (projectRoot === null || canonicalTargets.length === 0) return null
  if (!sandboxReadAccessPolicy().approvedFolders) return null
  const folders: string[] = []
  for (const target of canonicalTargets) {
    if (!isLiteralPath(target)) return null
    try {
      if (!statSync(target).isDirectory()) return null
    } catch {
      return null
    }
    if (!approvedFolderStillSafe(target)) return null
    if (!folders.includes(target)) folders.push(target)
  }
  return projectReadFolderCapacity(projectRoot, folders.length) ? folders : null
}

/**
 * The running turn's project root, resolved as `getAgentProjectRoot` does but
 * from the light context store, so the sandbox overlay and the classifier
 * binding can ask without pulling the thread runtime into worker bundles.
 */
export function currentReadGrantProjectRoot(): string | null {
  return currentThreadExecutionContext()?.projectRoot ?? getExplicitWorkspaceRoot()
}
