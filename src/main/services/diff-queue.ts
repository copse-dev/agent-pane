import * as fsp from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { resolveWorkspacePath } from './workspace.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { buildIndex } from './file-index.ts'

interface QueueEntry {
  path: string
  before: string
  after: string
  language: string
}

export type ApplyResult =
  | { status: 'written' }
  | { status: 'conflict'; current: string }
  | { status: 'error'; error: string }

const queue: QueueEntry[] = []
let mainWindow: BrowserWindow | null = null

/**
 * Apply a staged diff entry to disk, guarding against stale-overwrite TOCTOU.
 *
 * `before` was snapshotted when the diff was staged. If the on-disk content no
 * longer matches that snapshot, something else (a formatter from run_shell,
 * another approval, an external editor) changed the file in between. Writing the
 * agent's whole-file `after` would silently discard that change, so we refuse
 * and report the conflict instead of overwriting (#117).
 *
 * Missing parent directories are created first so brand-new nested paths can be
 * written (#120), and any write failure is captured as an `error` result rather
 * than thrown so batch callers can isolate it from the rest (#118).
 */
export async function applyDiffEntry(entry: QueueEntry): Promise<ApplyResult> {
  const absPath = resolveWorkspacePath(entry.path)
  let current = ''
  try {
    current = await fsp.readFile(absPath, 'utf-8')
  } catch {
    /* file absent on disk — treated as empty, matching staging snapshot for new files */
  }
  if (current !== entry.before) {
    return { status: 'conflict', current }
  }
  try {
    await fsp.mkdir(dirname(absPath), { recursive: true })
    await fsp.writeFile(absPath, entry.after, 'utf-8')
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  return { status: 'written' }
}

export function initDiffQueue(win: BrowserWindow): void {
  mainWindow = win

  ipcMain.handle('diff:approve', async (_e, path: string) => {
    const entry = queue.find((e) => e.path === path)
    if (!entry) return
    const result = await applyDiffEntry(entry)
    if (result.status === 'conflict') {
      restage(entry, result.current)
      mainWindow?.webContents.send('diff:conflict', [entry.path])
      return
    }
    if (result.status === 'error') {
      // Leave the entry queued so the user can retry; surface the failure.
      throw new Error(`Failed to write ${entry.path}: ${result.error}`)
    }
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    removeEntry(path)
  })

  ipcMain.handle('diff:reject', (_e, path: string) => {
    removeEntry(path)
  })

  ipcMain.handle('diff:approveAll', async () => {
    const conflicts: string[] = []
    const failures: { path: string; error: string }[] = []
    const remaining: QueueEntry[] = []
    let wroteAny = false
    for (const entry of queue) {
      const result = await applyDiffEntry(entry)
      if (result.status === 'conflict') {
        restage(entry, result.current)
        conflicts.push(entry.path)
        remaining.push(entry)
      } else if (result.status === 'error') {
        // Per-entry failure isolation (#118): keep the failed entry queued for
        // retry and continue applying the rest.
        failures.push({ path: entry.path, error: result.error })
        remaining.push(entry)
      } else {
        wroteAny = true
      }
    }
    if (wroteAny) {
      const root = getWorkspaceRoot()
      if (root) await buildIndex(root)
    }
    queue.length = 0
    queue.push(...remaining)
    if (conflicts.length) mainWindow?.webContents.send('diff:conflict', conflicts)
    broadcastQueue()
    if (failures.length > 0) {
      throw new Error(
        `Failed to write ${failures.length} file(s):\n${failures
          .map((f) => `  ${f.path}: ${f.error}`)
          .join('\n')}`,
      )
    }
  })

  ipcMain.handle('diff:rejectAll', () => {
    queue.length = 0
    broadcastQueue()
  })
}

/**
 * Re-stage an entry after a conflict: refresh its `before` snapshot to the
 * current on-disk content and re-emit the diff so the user reviews their change
 * against the file's real state before re-approving.
 */
function restage(entry: QueueEntry, current: string): void {
  entry.before = current
  mainWindow?.webContents.send(
    'agent:show_diff',
    entry.path,
    entry.before,
    entry.after,
    entry.language,
  )
}

export function stageDiff(
  path: string,
  before: string,
  after: string,
  language: string,
): Promise<string> {
  queue.push({ path, before, after, language })
  // Payload before queue broadcast so the renderer can populate activeDiff first.
  mainWindow?.webContents.send('agent:show_diff', path, before, after, language)
  broadcastQueue()
  return Promise.resolve(
    `Diff staged for ${path}. Approve or reject in the diff panel — the file is not written until accepted.`,
  )
}

function removeEntry(path: string): void {
  const idx = queue.findIndex((e) => e.path === path)
  if (idx !== -1) queue.splice(idx, 1)
  broadcastQueue()
}

function broadcastQueue(): void {
  mainWindow?.webContents.send(
    'diff:queued',
    queue.map((e) => ({ path: e.path, language: e.language })),
  )
}
