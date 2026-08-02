import { $ } from '@wdio/globals'

/**
 * Resolve the `run_shell` approval prompt when the platform has no OS sandbox.
 *
 * With macOS seatbelt active a contained, non-destructive command auto-runs, so
 * no dialog appears. Without it (Linux/Windows CI) `decideShellPermission` falls
 * through to `OS sandbox unavailable — prompt required` and every agent shell
 * command waits on the user — a spec that never answers leaves its tool card
 * pinned at `data-status="running"` forever. Mirrors the inline pattern in
 * `agent-tasks-terminal.e2e.ts`.
 */
export async function approveShellCommandIfPrompted(): Promise<void> {
  const dialog = await $('#approval-dialog')
  const approvalShown = await dialog
    .waitForDisplayed({ timeout: process.platform === 'darwin' ? 1_000 : 15_000 })
    .then(() => true)
    .catch(() => false)
  if (!approvalShown) return

  await dialog.$('.approval-approve').click()
  await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
}
