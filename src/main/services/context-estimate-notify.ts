import { getMainWindow } from '../windows/create-main-window.ts'

/** Ask the composer to re-run the pre-send context estimate (skills/tools changed). */
export function notifyRefreshContextEstimate(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:refresh_context_estimate')
  }
}
