import * as fs from 'node:fs'
import { ipcMain, type BrowserWindow } from 'electron'
import { resolveWorkspacePath } from '../services/workspace.ts'
import { gatewayReadFile } from '../project-sandbox/sandbox-fs-client.ts'

const watchers = new Map<string, fs.FSWatcher>()

export function initFsWatcher(win: BrowserWindow): void {
  ipcMain.handle('fs:watch', (_e, path: string) => {
    const abs = resolveWorkspacePath(path)
    if (watchers.has(abs)) return
    let debounce: ReturnType<typeof setTimeout>
    const w = fs.watch(abs, { persistent: false }, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        gatewayReadFile(abs)
          .then((content) => win.webContents.send('fs:changed', path, content))
          .catch(() => undefined)
      }, 200)
    })
    watchers.set(abs, w)
  })

  ipcMain.handle('fs:unwatch', (_e, path: string) => {
    const abs = resolveWorkspacePath(path)
    watchers.get(abs)?.close()
    watchers.delete(abs)
  })
}

export function closeAllWatchers(): void {
  watchers.forEach((w) => w.close())
  watchers.clear()
}
