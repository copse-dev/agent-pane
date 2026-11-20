import { BrowserWindow, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { workspacePreviewFileUrl } from '../services/browser/static-preview-server.ts'
import { resolvePathWithinRoot, resolveSshHostForWorkspaceRoot } from '../services/workspace.ts'
import { assertMainFrameSender, IpcValidationError, parseIpcArgs } from './ipc-guards.ts'
import { threadPathArgs } from './thread-path-args.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'
import {
  externalLinkConfirmationDetail,
  openExternalWithConsent,
} from '../services/external-link-consent.ts'

export function registerShellHandlers(win: BrowserWindow): void {
  ipcMain.handle('shell:open-external', async (event, url: unknown) => {
    assertMainFrameSender(event, win)
    const href = parseIpcArgs(z.url().max(2048), [url])
    if (!href.startsWith('http://') && !href.startsWith('https://')) {
      throw new IpcValidationError('URL must be http or https')
    }
    const opened = await openExternalWithConsent(
      href,
      (review) =>
        confirmNativeAction(event.sender, {
          title: 'Open external website?',
          detail: externalLinkConfirmationDetail(review),
          approveLabel: 'Open link',
        }),
      (reviewedHref) => shell.openExternal(reviewedHref),
    )
    if (!opened) throw new IpcValidationError('External link was not confirmed')
  })
  ipcMain.handle('shell:open-workspace-file-in-browser', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root, projectRoot } = await resolveThreadExecutionContext(projectId, threadId)
    if (resolveSshHostForWorkspaceRoot(projectRoot)) {
      throw new IpcValidationError('Remote workspace files cannot be opened in a local browser')
    }
    const abs = await resolvePathWithinRoot(relPath, root)
    if (
      !(await confirmNativeAction(event.sender, {
        title: 'Open workspace file in browser?',
        detail: `Open ${JSON.stringify(abs)} in your system browser outside Copse?`,
        approveLabel: 'Open file',
      }))
    ) {
      throw new IpcValidationError('Workspace file open was not confirmed')
    }
    return shell.openExternal(await workspacePreviewFileUrl(root, abs))
  })
  ipcMain.handle('browser:workspace-file-url', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root, projectRoot } = await resolveThreadExecutionContext(projectId, threadId)
    if (resolveSshHostForWorkspaceRoot(projectRoot)) {
      throw new IpcValidationError('Remote workspace files cannot be opened in a local browser')
    }
    const abs = await resolvePathWithinRoot(relPath, root)
    return workspacePreviewFileUrl(root, abs)
  })
}
