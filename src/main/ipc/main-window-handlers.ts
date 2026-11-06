import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineSenderHandler } from './define-handler.ts'
import {
  mainWindowSetBrowserSessionArgs,
  mainWindowSetNavigationArgs,
} from './main-window-handler-args.ts'
import {
  getMainWindowBrowserSession,
  getMainWindowNavigation,
  setMainWindowBrowserSession,
  setMainWindowNavigation,
} from '../windows/create-main-window.ts'
import { decodeBrowserPaneSession } from '../windows/main-window-state.ts'

export function registerMainWindowHandlers(win: BrowserWindow): void {
  defineSenderHandler(win, 'main-window:get-navigation', z.tuple([]), (sender) =>
    getMainWindowNavigation(sender),
  )

  defineSenderHandler(
    win,
    'main-window:set-navigation',
    mainWindowSetNavigationArgs,
    (sender, navigation) => {
      setMainWindowNavigation(sender, navigation)
    },
  )

  // The Browser pane's tabs, so quitting no longer throws away the canvas the
  // agent rendered. Stored per window beside its navigation and bounded by the
  // same schema the launch-time decode uses.
  defineSenderHandler(win, 'main-window:get-browser-session', z.tuple([]), (sender) =>
    getMainWindowBrowserSession(sender),
  )

  defineSenderHandler(
    win,
    'main-window:set-browser-session',
    mainWindowSetBrowserSessionArgs,
    (sender, session) => {
      setMainWindowBrowserSession(sender, decodeBrowserPaneSession(session))
    },
  )
}
