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

const queue: QueueEntry[] = []
let mainWindow: BrowserWindow | null = null

/** Write one staged file, creating any missing parent directories first (#120). */
async function writeApprovedFile(workspacePath: string, contents: string): Promise<void> {
  const abs = resolveWorkspacePath(workspacePath)
  await fsp.mkdir(dirname(abs), { recursive: true })
  await fsp.writeFile(abs, contents, 'utf-8')
}

export interface ApproveAllOutcome {
  succeeded: string[]
  failures: { path: string; error: string }[]
}

/**
 * Apply a batch of staged writes with per-entry failure isolation (#118): one
 * failing write must not abort the rest, and only entries that were actually
 * written are reported as succeeded. Pure (injected `write`) so it is testable
 * without Electron.
 */
export async function applyApprovals(
  entries: readonly QueueEntry[],
  write: (path: string, contents: string) => Promise<void>,
): Promise<ApproveAllOutcome> {
  const succeeded: string[] = []
  const failures: { path: string; error: string }[] = []
  for (const entry of entries) {
    try {
      await write(entry.path, entry.after)
      succeeded.push(entry.path)
    } catch (err) {
      failures.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { succeeded, failures }
}

export function initDiffQueue(win: BrowserWindow): void {
  mainWindow = win

  ipcMain.handle('diff:approve', async (_e, path: string) => {
    const entry = queue.find((e) => e.path === path)
    if (!entry) return
    await writeApprovedFile(entry.path, entry.after)
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    removeEntry(path)
  })

  ipcMain.handle('diff:reject', (_e, path: string) => {
    removeEntry(path)
  })

  ipcMain.handle('diff:approveAll', async () => {
    const { succeeded, failures } = await applyApprovals([...queue], writeApprovedFile)
    // Remove only the entries we actually wrote; leave failures queued for retry.
    for (const path of succeeded) {
      const idx = queue.findIndex((e) => e.path === path)
      if (idx !== -1) queue.splice(idx, 1)
    }
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
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
