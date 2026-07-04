import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { loadProjectCatalog, saveProjectThread } from './thread-store.ts'

/**
 * ONE-TIME migration (issue #644). Imports threads from the pre-#644 store — one
 * JSON blob per thread at `<userData>/threads/<projectId>/<threadId>.json` — into
 * the new `~/.copse/workspace` directory store, then archives the old directory
 * so it runs exactly once.
 *
 * Deliberately self-contained: this file plus its single call site in
 * `main/index.ts` are the whole feature. If we decide not to carry old threads
 * forward, either delete both, or replace {@link migrateLegacyThreads}'s body
 * with a one-line cleanup (`rmSync(legacyThreadsDir(), { recursive: true })`).
 *
 * Scope: only the file-based pre-#644 format is imported. The even older
 * electron-store `threads:<projectId>` blobs were already migrated to files by
 * prior releases, so an upgrade path through them is not handled here.
 */

const ARCHIVE_SUFFIX = '.pre-copse-workspace'

function legacyUserDataDir(): string {
  const override = process.env['COPSE_PANEL_USER_DATA']?.trim()
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'copse-panel')
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'copse-panel')
  }
  return join(homedir(), '.config', 'copse-panel')
}

function legacyThreadsDir(): string {
  return join(legacyUserDataDir(), 'threads')
}

function parseThread(raw: string): Thread | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Thread).id === 'string'
    ) {
      return parsed as Thread
    }
    return null
  } catch {
    return null
  }
}

export interface MigrationResult {
  ranMigration: boolean
  projects: number
  migrated: number
  skipped: number
}

/** Import legacy threads into the new store. Idempotent; safe to call on every launch. */
export async function migrateLegacyThreads(): Promise<MigrationResult> {
  const dir = legacyThreadsDir()
  if (!existsSync(dir)) return { ranMigration: false, projects: 0, migrated: 0, skipped: 0 }

  let projects = 0
  let migrated = 0
  let skipped = 0

  for (const projectId of readdirSync(dir)) {
    const projectDir = join(dir, projectId)
    let entries: string[]
    try {
      entries = readdirSync(projectDir).filter((name) => name.endsWith('.json'))
    } catch {
      continue
    }
    if (entries.length === 0) continue
    projects++

    // Never clobber threads that already exist in the new store (e.g. a re-run
    // after a failed archive, once the user has started using the new store).
    const existing = new Set((await loadProjectCatalog(projectId)).map((entry) => entry.id))

    for (const file of entries) {
      const thread = parseThread(readFileSync(join(projectDir, file), 'utf8'))
      if (!thread || existing.has(thread.id)) {
        skipped++
        continue
      }
      await saveProjectThread(projectId, thread)
      migrated++
    }
  }

  archiveLegacyDir(dir)
  return { ranMigration: true, projects, migrated, skipped }
}

/** Rename the old dir aside (recoverable) so the migration runs once; rm if a backup already exists. */
function archiveLegacyDir(dir: string): void {
  const backup = `${dir}${ARCHIVE_SUFFIX}`
  try {
    if (existsSync(backup)) rmSync(dir, { recursive: true, force: true })
    else renameSync(dir, backup)
  } catch {
    // Best-effort: if it fails, the old dir remains and migration retries next
    // launch. Re-import is safe — existing threads are skipped above.
  }
}
