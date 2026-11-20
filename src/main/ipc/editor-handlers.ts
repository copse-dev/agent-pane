import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import {
  listExternalEditors,
  openWorkspaceInExternalEditor,
} from '../services/editors/editor-launcher.ts'

export function registerEditorHandlers(win: BrowserWindow): void {
  ipcMain.handle('editors:list', (event) => {
    assertMainFrameSender(event, win)
    return listExternalEditors()
  })
  ipcMain.handle('editors:open', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, parsedId] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)]),
      rawArgs,
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    return openWorkspaceInExternalEditor(parsedId, root)
  })
}
