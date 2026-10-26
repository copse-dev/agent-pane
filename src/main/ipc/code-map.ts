import { basename } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { collectProjectFiles } from '../services/code-map/code-map-files.ts'
import { bundledBlockvizDistPath } from '../services/code-map/code-map-assets.ts'
import { getCodeMapAssetServer } from '../services/code-map/code-map-server.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'

const threadArgs = z.tuple([zProjectId, zThreadId])

export function initCodeMap(win: BrowserWindow): void {
  ipcMain.handle('codemap:get-files', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const files = await collectProjectFiles(root)
    return { name: basename(root), files }
  })

  ipcMain.handle('codemap:get-preview-url', (event) => {
    assertMainFrameSender(event, win)
    const dist = bundledBlockvizDistPath()
    if (!dist) {
      throw new Error(
        'blockviz is not built — run `npm install && npm run build` in vendor/blockviz.',
      )
    }
    return getCodeMapAssetServer(dist).then(({ url }) => url)
  })
}
