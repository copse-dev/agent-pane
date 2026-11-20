import { BrowserWindow, ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  BROWSER_SESSION_PARTITION,
  browserSessionPartition,
  browserThreadScope,
} from '@shared/browser-session.ts'
import {
  isStaticPreviewUrl,
  workspacePreviewFileUrl,
} from '../services/browser/static-preview-server.ts'
import { resolvePathWithinRoot, resolveSshHostForWorkspaceRoot } from '../services/workspace.ts'
import { assertMainFrameSender, IpcValidationError, parseIpcArgs } from './ipc-guards.ts'
import { threadPathArgs } from './thread-path-args.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { authorizeBrowserPartitionPreview } from '../windows/browser-web-contents.ts'

export function registerShellHandlers(win: BrowserWindow): void {
  ipcMain.handle('shell:open-external', (event, url: unknown) => {
    assertMainFrameSender(event, win)
    const href = parseIpcArgs(z.url().max(2048), [url])
    if (!href.startsWith('http://') && !href.startsWith('https://')) {
      throw new IpcValidationError('URL must be http or https')
    }
    if (isStaticPreviewUrl(href)) {
      throw new IpcValidationError('Workspace previews open inside Copse')
    }
    return shell.openExternal(href)
  })
  ipcMain.handle('browser:workspace-file-url', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root, projectRoot } = await resolveThreadExecutionContext(projectId, threadId)
    if (resolveSshHostForWorkspaceRoot(projectRoot)) {
      throw new IpcValidationError('Remote workspace files cannot be opened in a local browser')
    }
    const abs = await resolvePathWithinRoot(relPath, root)
    const url = await workspacePreviewFileUrl(root, abs)
    await authorizeBrowserPartitionPreview(
      browserSessionPartition(BROWSER_SESSION_PARTITION, browserThreadScope(projectId, threadId)),
      url,
    )
    return url
  })
}
