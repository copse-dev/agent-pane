import { dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { dirname } from 'node:path'
import micromatch from 'micromatch'
import * as fsp from 'node:fs/promises'
import { getWorkspaceRoot, setWorkspaceRoot, resolveWorkspacePath } from '../services/workspace.ts'
import { buildIndex, getIndex } from '../services/file-index.ts'
import {
  getSetting,
  setSetting,
  getApiKey,
  setApiKey,
  isProviderAvailable,
} from '../services/settings.ts'
import { storageGet, storageSet } from '../services/storage.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'

export function registerAllHandlers(_win: BrowserWindow, _registry: ToolRegistry): void {
  ipcMain.handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const root = result.filePaths[0]
    setWorkspaceRoot(root)
    await buildIndex(root)
    return root
  })

  ipcMain.handle('workspace:get', () => getWorkspaceRoot())

  // Switch to a known folder without a dialog (used when picking a saved
  // project from the left pane).
  ipcMain.handle('workspace:set', async (_e, root: string) => {
    setWorkspaceRoot(root)
    await buildIndex(root)
    return root
  })

  ipcMain.handle('fs:readFile', async (_e, path: string) => {
    const abs = resolveWorkspacePath(path)
    return fsp.readFile(abs, 'utf-8')
  })

  ipcMain.handle('fs:writeFile', async (_e, path: string, content: string) => {
    const abs = resolveWorkspacePath(path)
    await fsp.mkdir(dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf-8')
  })

  ipcMain.handle('fs:readdir', async (_e, path: string) => {
    const abs = resolveWorkspacePath(path)
    const entries = await fsp.readdir(abs)
    return entries
  })

  // Directory listing with type info, for the file-tree sidebar. Hides dotfiles
  // and node_modules, sorts directories first then alphabetically. `path` is
  // relative to the workspace root ('' = root).
  ipcMain.handle('fs:listDir', async (_e, path: string) => {
    const abs = resolveWorkspacePath(path || '.')
    const dirents = await fsp.readdir(abs, { withFileTypes: true })
    return dirents
      .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
      )
  })

  ipcMain.handle('index:query', (_e, pattern: string) => {
    const idx = getIndex()
    if (!idx) return []
    return pattern ? micromatch(idx.paths, `**/*${pattern}*`).slice(0, 20) : idx.paths.slice(0, 20)
  })

  ipcMain.handle('settings:get', (_e, key: string) => getSetting(key, null))
  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => setSetting(key, value))
  ipcMain.handle(
    'settings:getKey',
    (_e, provider: 'anthropic' | 'openai' | 'lmstudio') => getApiKey(provider) !== null,
  )
  ipcMain.handle(
    'settings:setKey',
    (_e, provider: 'anthropic' | 'openai' | 'lmstudio', key: string) => setApiKey(provider, key),
  )
  ipcMain.handle('settings:availableProviders', () => ({
    anthropic: isProviderAvailable('anthropic'),
    openai: isProviderAvailable('openai'),
  }))
  ipcMain.handle('storage:get', (_e, key: string) => storageGet(key))
  ipcMain.handle('storage:set', (_e, key: string, value: unknown) => storageSet(key, value))
}
