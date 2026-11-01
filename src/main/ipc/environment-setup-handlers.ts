import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import {
  applyEnvironmentSetup,
  dismissEnvironmentSetup,
  environmentSetupStatus,
  reviewEnvironmentSetup,
  undoEnvironmentSetup,
  type EnvironmentSetupProject,
} from '../services/security/environment-setup.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { getMainWindowNavigation } from '../windows/create-main-window.ts'

/** The project open in the asking window, not whichever window opened last. */
function senderProject(sender: WebContents): EnvironmentSetupProject {
  const projectId = getMainWindowNavigation(sender).activeProjectId
  return { projectId, root: projectId === null ? null : getProjectRoot(projectId) }
}

export function registerEnvironmentSetupHandlers(win: BrowserWindow): void {
  // Environment setup: the renderer sends only which issued suggestion ids were
  // ticked; main applies the values it computed (docs/plans/environment-setup.md).
  ipcMain.handle('environment-setup:status', (event) => {
    assertMainFrameSender(event, win)
    return environmentSetupStatus(senderProject(event.sender))
  })
  ipcMain.handle('environment-setup:review', (event) => {
    assertMainFrameSender(event, win)
    return reviewEnvironmentSetup(senderProject(event.sender))
  })
  ipcMain.handle('environment-setup:apply', (event, rawReview: unknown, rawIds: unknown) => {
    assertMainFrameSender(event, win)
    const [reviewId, ids] = parseIpcArgs(z.tuple([z.uuid(), z.array(z.uuid()).max(64)]), [
      rawReview,
      rawIds,
    ])
    return applyEnvironmentSetup(senderProject(event.sender).projectId, reviewId, ids)
  })
  ipcMain.handle('environment-setup:undo', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return undoEnvironmentSetup(parseIpcArgs(z.uuid(), [raw]))
  })
  ipcMain.handle('environment-setup:dismiss', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return dismissEnvironmentSetup(parseIpcArgs(z.boolean(), [raw]))
  })
}
