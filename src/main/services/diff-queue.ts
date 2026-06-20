import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { getWorkspaceRoot } from './workspace.ts'
import { buildIndex } from './file-index.ts'
import { applyStagedWrite } from './apply-staged-write.ts'
import type { DiffApplyResult } from '@shared/types/diff.ts'

interface QueueEntry {
  path: string
  before: string
  after: string
  language: string
}

const queue: QueueEntry[] = []
let mainWindow: BrowserWindow | null = null

export function initDiffQueue(win: BrowserWindow): void {
  mainWindow = win

  ipcMain.handle('diff:approve', async (_e, path: string): Promise<DiffApplyResult> => {
    const entry = queue.find((e) => e.path === path)
    if (!entry) return { ok: false, reason: 'missing_entry', message: 'Diff no longer queued.' }
    const result = await applyStagedWrite(entry.path, entry.before, entry.after)
    if (!result.ok) {
      mainWindow?.webContents.send('diff:apply_failed', path, result.message)
      return result
    }
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    removeEntry(path)
    return result
  })

  ipcMain.handle('diff:reject', (_e, path: string) => {
    removeEntry(path)
  })

  ipcMain.handle('diff:approveAll', async (): Promise<DiffApplyResult[]> => {
    const results: DiffApplyResult[] = []
    for (const entry of [...queue]) {
      const result = await applyStagedWrite(entry.path, entry.before, entry.after)
      results.push(result)
      if (!result.ok) {
        mainWindow?.webContents.send('diff:apply_failed', entry.path, result.message)
        continue
      }
      removeEntry(entry.path)
    }
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    broadcastQueue()
    return results
  })

  ipcMain.handle('diff:rejectAll', () => {
    queue.length = 0
    broadcastQueue()
  })
}

export function stageDiff(
  path: string,
  before: string,
  after: string,
  language: string,
): Promise<string> {
  queue.push({ path, before, after, language })
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
