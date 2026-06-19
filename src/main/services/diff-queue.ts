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
  resolve: (result: string) => void
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
    entry.resolve(`File written: ${path}`)
    removeEntry(path)
  })

  ipcMain.handle('diff:reject', (_e, path: string) => {
    const entry = queue.find((e) => e.path === path)
    if (!entry) return
    entry.resolve('User rejected the file change.')
    removeEntry(path)
  })

  ipcMain.handle('diff:approveAll', async () => {
    for (const entry of [...queue]) {
      await fsp.writeFile(resolveWorkspacePath(entry.path), entry.after, 'utf-8')
      entry.resolve(`File written: ${entry.path}`)
    }
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    queue.length = 0
    broadcastQueue()
  })

  ipcMain.handle('diff:rejectAll', () => {
    queue.forEach((e) => e.resolve('User rejected the file change.'))
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
  return new Promise((resolve) => {
    queue.push({ path, before, after, language, resolve })
    broadcastQueue()
    mainWindow?.webContents.send('agent:show_diff', path, before, after, language)
  })
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
