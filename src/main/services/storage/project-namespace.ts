import { createHash } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  getThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'
import { getActiveProjectId, getActiveProjectRoot, getProjectRoot } from '../workspace.ts'

/**
 * Per-project directory name for the small feature stores (knowledge, long
 * tasks, roadmap review) that live directly under the Copse data root.
 *
 * Keyed by the project's **id**, which is stable for the life of the project.
 * These stores used to key by a hash of the project's absolute path, which is
 * not: relocating a project — moving the repo, recovering a quarantined folder,
 * or restoring a profile onto a machine where `$HOME` differs — changed the
 * hash, so the store silently started empty while the old data sat under the
 * previous hash. Threads never had this problem because they were already keyed
 * by id (#1709).
 *
 * The legacy name is still derived, so {@link projectStoreNamespaceDir} can
 * carry an existing directory across on first use.
 */
function legacyPathNamespace(root: string): string {
  const name = slugify(basename(root)) || 'workspace'
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Which project a store belongs to: its persisted id (the directory name) and
 * its root (used for the no-project fallback and the one-time legacy
 * migration). The two always travel together — resolving an id from one
 * source and a root from another is how one project's legacy directory could
 * be migrated under another project's id.
 */
export interface ProjectStoreScope {
  /** Persisted project id, or null when there is none to key by (headless runs). */
  readonly projectId: string | null
  /** That project's root directory, or null when no project is open. */
  readonly root: string | null
}

/**
 * The scope for code running on behalf of a thread: that thread's project.
 *
 * A headless run synthesises a project id that is never persisted (and differs
 * on every run), so only an id the project list knows is used as the key.
 * Otherwise the scope is root-only, and resolves to the same legacy directory
 * those profiles have always used.
 */
export function threadProjectStoreScope(
  context: Pick<ThreadExecutionContext, 'projectId' | 'projectRoot'>,
): ProjectStoreScope {
  const persisted = getProjectRoot(context.projectId) !== null
  return { projectId: persisted ? context.projectId : null, root: context.projectRoot }
}

/** The scope of an explicitly named project. */
export function projectStoreScopeFor(projectId: string): ProjectStoreScope {
  return { projectId, root: getProjectRoot(projectId) }
}

/**
 * The project whose stores the current call belongs to.
 *
 * Inside an agent turn that is the turn's own project, not the active one: runs
 * keep going after the user switches projects, and a background thread must
 * not read or write the newly active project's knowledge, roadmap or long
 * tasks. With no turn in scope (IPC from the renderer's panes, which show the
 * active project) it falls back to the active project.
 */
export function currentProjectStoreScope(): ProjectStoreScope {
  const context = getThreadExecutionContext()
  if (context) return threadProjectStoreScope(context)
  return { projectId: getActiveProjectId(), root: getActiveProjectRoot() }
}

/**
 * Resolve `<baseDir>/<namespace>` for a project, migrating a path-hashed
 * directory from the old scheme into the id-keyed name the first time it is
 * needed.
 *
 * With no project open — before the first folder is opened — both schemes fall
 * back to `shared`, so those callers are unaffected.
 *
 * `scope` defaults to {@link currentProjectStoreScope}; callers that already
 * know which project they act for pass it explicitly.
 */
export function projectStoreNamespaceDir(
  baseDir: string,
  scope: ProjectStoreScope = currentProjectStoreScope(),
): string {
  const { projectId, root } = scope
  if (!root) return join(baseDir, 'shared')

  // No id to key by (headless runs scope by workspace root alone): keep the
  // legacy name so those profiles neither migrate nor lose their data.
  if (!projectId) return join(baseDir, legacyPathNamespace(root))

  const target = join(baseDir, projectId)
  if (existsSync(target)) return target

  const legacy = join(baseDir, legacyPathNamespace(root))
  // Only adopt the legacy directory when `root` is this project's own persisted
  // path. A root that belongs to some other project (or to none) must never
  // have its data moved under this id.
  if (legacy !== target && existsSync(legacy) && getProjectRoot(projectId) === root) {
    try {
      renameSync(legacy, target)
    } catch {
      // Losing the race with another window, or an unwritable root, must not
      // fail the read that triggered this. The next call retries; until then the
      // caller gets an empty (or newly created) directory rather than an error.
      return existsSync(target) ? target : legacy
    }
  }
  return target
}
