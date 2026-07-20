import { $, expect } from '@wdio/globals'

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
