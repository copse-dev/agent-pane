import { z } from 'zod'
import { browserPaneSessionSchema } from '../windows/main-window-state.ts'
import { mainWindowNavigationSchema } from './ipc-guards.ts'

// Argument schemas for the `main-window:set-*` channels. They live apart from
// the handlers, which import Electron, so the parity tests in
// `ipc-handler.test.ts` check the schemas the channels use.

/** `main-window:set-navigation (navigation)`. */
export const mainWindowSetNavigationArgs = z.tuple([mainWindowNavigationSchema])
/** `main-window:set-browser-session (session)`. */
export const mainWindowSetBrowserSessionArgs = z.tuple([browserPaneSessionSchema])
