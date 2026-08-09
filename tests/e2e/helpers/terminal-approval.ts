import { $, expect } from '@wdio/globals'

/**
 * Is the approval prompt up *right now*?
 *
 * {@link approveUnsandboxedTerminalIfPrompted} waits up to 10s to find out,
 * which is the right budget when approving is the next thing to happen and the
 * wrong one inside a poll — every iteration that found no dialog would pay it.
 * Use this to gate that call when approving is only one of the things a wait is
 * watching for.
 */
export async function approvalDialogShowing(): Promise<boolean> {
  return await $('#approval-dialog')
    .isDisplayed()
    .catch(() => false)
}

/**
 * On platforms without an OS sandbox (Linux/Windows CI), opening the integrated
 * terminal prompts for approval. macOS seatbelt usually skips that dialog.
 */
export async function approveUnsandboxedTerminalIfPrompted(): Promise<void> {
  const dialog = await $('#approval-dialog')
  const approvalShown = await dialog
    .waitForDisplayed({ timeout: process.platform === 'darwin' ? 1_000 : 10_000 })
    .then(() => true)
    .catch(() => false)
  if (!approvalShown) return

  await expect(dialog.$('.approval-heading')).toHaveText('Open unsandboxed terminal?')
  await dialog.$('.approval-approve').click()
  await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
}
