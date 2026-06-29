import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { ipcMain, type BrowserWindow } from 'electron'
import { assertMainFrameSender, parseIpcArgs, zPathString } from './ipc-guards.ts'
import { isResolvedPathInsideWorkspace, resolveWorkspacePath } from '../services/workspace.ts'
import { gatewayReadFile } from '../project-sandbox/sandbox-fs-client.ts'
import { FS_WATCH_MAX_CONTENT_BYTES } from '../services/fs-watch-limits.ts'

const watchers = new Map<string, fs.FSWatcher>()

export function initFsWatcher(win: BrowserWindow): void {
  ipcMain.handle('fs:watch', (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const rel = parseIpcArgs(zPathString, [path])
    const abs = resolveWorkspacePath(rel)
    if (watchers.has(abs)) return
    let debounce: ReturnType<typeof setTimeout>
    const w = fs.watch(abs, { persistent: false }, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        void notifyFileChanged(win, rel, abs)
      }, 200)
    })
    watchers.set(abs, w)
  })

  ipcMain.handle('fs:unwatch', (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const rel = parseIpcArgs(zPathString, [path])
    const abs = resolveWorkspacePath(rel)
    watchers.get(abs)?.close()
    watchers.delete(abs)
  })
}

async function notifyFileChanged(
  win: BrowserWindow,
  relPath: string,
  absPath: string,
): Promise<void> {
  try {
    // TOCTOU guard: `absPath` was containment-checked once at watch
    // registration, but `fs.watch` follows the live filesystem. Re-resolve the
    // real on-disk location and skip the event if a swapped symlink now points
    // outside the workspace.
    if (!isResolvedPathInsideWorkspace(absPath)) return
    const st = await fsp.stat(absPath)
    if (!st.isFile()) return
    if (st.size > FS_WATCH_MAX_CONTENT_BYTES) {
      win.webContents.send('fs:changed', relPath, null)
      return
    }
    const content = await gatewayReadFile(absPath)
    win.webContents.send('fs:changed', relPath, content)
  } catch {
    /* ignore missing/unreadable files */
  }
}

export function closeAllWatchers(): void {
  watchers.forEach((w) => {
    w.close()
  })
  watchers.clear()
}
