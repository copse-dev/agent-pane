import * as fsp from 'node:fs/promises'
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

const queue: QueueEntry[] = []
let mainWindow: BrowserWindow | null = null

export function initDiffQueue(win: BrowserWindow): void {
  mainWindow = win

  ipcMain.handle('diff:approve', async (_e, path: string) => {
    const entry = queue.find((e) => e.path === path)
    if (!entry) return
    await fsp.writeFile(resolveWorkspacePath(path), entry.after, 'utf-8')
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    removeEntry(path)
  })

  ipcMain.handle('diff:reject', (_e, path: string) => {
    removeEntry(path)
  })

  ipcMain.handle('diff:approveAll', async () => {
    for (const entry of [...queue]) {
      await fsp.writeFile(resolveWorkspacePath(entry.path), entry.after, 'utf-8')
    }
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    queue.length = 0
    broadcastQueue()
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
