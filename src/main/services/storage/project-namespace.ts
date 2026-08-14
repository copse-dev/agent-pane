import { createHash } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getActiveProjectId, getActiveProjectRoot } from '../workspace.ts'

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
 * Resolve `<baseDir>/<namespace>` for the active project, migrating a
 * path-hashed directory from the old scheme into the id-keyed name the first
 * time it is needed.
 *
 * With no project open — a headless run, or before the first folder is opened —
 * both schemes fall back to `shared`, so those callers are unaffected.
 *
 * `root` may be passed explicitly by callers that already resolved it for a
 * specific project rather than the active one.
 */
export function projectStoreNamespaceDir(
  baseDir: string,
  root: string | null = getActiveProjectRoot(),
): string {
  if (!root) return join(baseDir, 'shared')

  const projectId = getActiveProjectId()
  // No id to key by (headless runs scope by workspace root alone): keep the
  // legacy name so those profiles neither migrate nor lose their data.
  if (!projectId) return join(baseDir, legacyPathNamespace(root))

  const target = join(baseDir, projectId)
  if (existsSync(target)) return target

  const legacy = join(baseDir, legacyPathNamespace(root))
  if (legacy !== target && existsSync(legacy)) {
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
