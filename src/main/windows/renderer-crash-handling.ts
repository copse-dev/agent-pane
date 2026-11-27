/**
 * The app's wiring for {@link attachRendererCrashRecovery}: what a main or
 * pop-out window logs, records and tells the user when its renderer dies.
 */

import { dialog, type BrowserWindow } from 'electron'
import { closeCrashedWindow } from '../services/close-confirm.ts'
import { appendRendererCrash, rendererCrashLogPath } from './renderer-crash-log.ts'
import {
  RENDERER_CRASH_LOOP_WINDOW_MS,
  applyCrashLoopChoice,
  attachRendererCrashRecovery,
} from './renderer-crash-recovery.ts'
import { largeIpcCalls } from './renderer-large-ipc.ts'

export function attachAppRendererCrashHandling(
  win: BrowserWindow,
  windowKind: 'main' | 'popout',
): void {
  // Read once: Electron throws on `win.webContents` after the window is destroyed.
  const webContentsId = win.webContents.id
  attachRendererCrashRecovery(win.webContents, {
    context: () => largeIpcCalls.describeRecent(webContentsId),
    record: (record) => {
      void appendRendererCrash({ ...record, window: windowKind })
    },
    onCrashLoop: (retry) => {
      if (win.isDestroyed()) return
      const minutes = String(RENDERER_CRASH_LOOP_WINDOW_MS / 60_000)
      void dialog
        .showMessageBox(win, {
          type: 'error',
          message: 'Copse’s window keeps crashing',
          detail:
            `This window’s interface crashed several times in ${minutes} minutes, so Copse ` +
            'stopped reloading it. Your saved conversations are not affected.\n\n' +
            `Each crash is recorded in ${rendererCrashLogPath()}, and /checkup lists recent ones.`,
          buttons: ['Reload Window', 'Close Window'],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (win.isDestroyed()) return
          applyCrashLoopChoice(response, {
            retry,
            destroy: () => {
              closeCrashedWindow(win)
            },
          })
        })
        .catch((error: unknown) => {
          console.warn('[renderer] could not show the crash-loop notice:', error)
        })
    },
  })
}
