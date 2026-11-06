import { BrowserWindow, ipcMain } from 'electron'
import { assertMainFrameSender, parseIpcArgs, mainWindowNavigationSchema } from './ipc-guards.ts'
import {
  getMainWindowBrowserSession,
  getMainWindowNavigation,
  setMainWindowBrowserSession,
  setMainWindowNavigation,
} from '../windows/create-main-window.ts'
import { browserPaneSessionSchema, decodeBrowserPaneSession } from '../windows/main-window-state.ts'

export function registerMainWindowHandlers(win: BrowserWindow): void {
  ipcMain.handle('main-window:get-navigation', (event) => {
    assertMainFrameSender(event, win)
    return getMainWindowNavigation(event.sender)
  })

  ipcMain.handle('main-window:set-navigation', (event, rawNavigation: unknown) => {
    assertMainFrameSender(event, win)
    const navigation = parseIpcArgs(mainWindowNavigationSchema, [rawNavigation])
    setMainWindowNavigation(event.sender, navigation)
  })

  // The Browser pane's tabs, so quitting no longer throws away the canvas the
  // agent rendered. Stored per window beside its navigation and bounded by the
  // same schema the launch-time decode uses.
  ipcMain.handle('main-window:get-browser-session', (event) => {
    assertMainFrameSender(event, win)
    return getMainWindowBrowserSession(event.sender)
  })

  ipcMain.handle('main-window:set-browser-session', (event, rawSession: unknown) => {
    assertMainFrameSender(event, win)
    const session = parseIpcArgs(browserPaneSessionSchema, [rawSession])
    setMainWindowBrowserSession(event.sender, decodeBrowserPaneSession(session))
  })
}
