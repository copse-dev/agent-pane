import type { BrowserWindow, WebContents } from 'electron'
import { z } from 'zod'
import { defineHandler, defineSenderHandler } from './define-handler.ts'
import {
  environmentSetupApplyArgs,
  environmentSetupDismissArgs,
  environmentSetupUndoArgs,
} from './security-handler-args.ts'
import {
  applyEnvironmentSetup,
  dismissEnvironmentSetup,
  environmentSetupStatus,
  previewEnvironmentSetupApply,
  reviewEnvironmentSetup,
  undoEnvironmentSetup,
  type EnvironmentSetupProject,
} from '../services/security/environment-setup.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { getMainWindowNavigation } from '../windows/create-main-window.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'

/** The project open in the asking window, not whichever window opened last. */
function senderProject(sender: WebContents): EnvironmentSetupProject {
  const projectId = getMainWindowNavigation(sender).activeProjectId
  return {
    projectId,
    root: projectId === null ? null : getProjectRoot(projectId),
  }
}

export function registerEnvironmentSetupHandlers(win: BrowserWindow): void {
  // Environment setup: the renderer sends only which issued suggestion ids were
  // ticked; main applies the values it computed (docs/plans/environment-setup.md).
  defineSenderHandler(win, 'environment-setup:status', z.tuple([]), (sender) =>
    environmentSetupStatus(senderProject(sender)),
  )
  defineSenderHandler(win, 'environment-setup:review', z.tuple([]), (sender) =>
    reviewEnvironmentSetup(senderProject(sender)),
  )
  defineSenderHandler(
    win,
    'environment-setup:apply',
    environmentSetupApplyArgs,
    async (sender, reviewId, ids) => {
      const project = senderProject(sender)
      const changes = previewEnvironmentSetupApply(project.projectId, reviewId, ids)
      if (changes.length > 0) {
        const confirmed = await confirmNativeAction(sender, {
          title: 'Apply environment permissions?',
          detail: `Project: ${JSON.stringify(project.root)}\n\nApply these permission changes?\n\n${changes.map((change) => `${change.kind}: ${JSON.stringify(change.value)} (${change.label})`).join('\n')}`,
          approveLabel: 'Apply permissions',
        })
        if (!confirmed) throw new Error('Environment permission changes were not confirmed')
      }
      return applyEnvironmentSetup(project.projectId, reviewId, ids)
    },
  )
  defineHandler(win, 'environment-setup:undo', environmentSetupUndoArgs, (applyId) =>
    undoEnvironmentSetup(applyId),
  )
  defineHandler(win, 'environment-setup:dismiss', environmentSetupDismissArgs, (dismissed) =>
    dismissEnvironmentSetup(dismissed),
  )
}
