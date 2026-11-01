import { BrowserWindow } from 'electron'
import { CHILD_COPSE_SESSION_PAGE, CHILD_COPSE_STOP_URL } from '@shared/child-copse-session.ts'

/** Parent-owned control: the desktop helper's Copse block also protects this window. */
export async function showChildCopseControl(stop: () => void): Promise<() => void> {
  const window = new BrowserWindow({
    width: 440,
    height: 360,
    title: 'Child Copse control',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url === CHILD_COPSE_STOP_URL || url === CHILD_COPSE_STOP_URL + '?') stop()
  })
  window.on('closed', stop)
  await window.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(CHILD_COPSE_SESSION_PAGE),
  )
  return () => {
    window.removeListener('closed', stop)
    if (!window.isDestroyed()) window.destroy()
  }
}
