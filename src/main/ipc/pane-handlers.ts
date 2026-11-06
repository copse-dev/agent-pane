import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { createPanePopoutWindow } from '../windows/create-popout-window.ts'
import { takePopoutSeed } from '../services/popout-seed-store.ts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'

export function registerPaneHandlers(win: BrowserWindow): void {
  ipcMain.handle('panes:popout', (event, mode: unknown, seed: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum([
        'explorer',
        'context',
        'side-chat',
        'terminal',
        'changes',
        'prs',
        'memories',
        'roadmap',
        'browser',
        'vnc',
      ]),
      [mode],
    )
    createPanePopoutWindow(parsed, seed)
  })

  ipcMain.handle('panes:take-popout-seed', (event, mode: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum([
        'explorer',
        'context',
        'side-chat',
        'terminal',
        'changes',
        'prs',
        'memories',
        'roadmap',
        'browser',
        'vnc',
      ]),
      [mode],
    )
    return takePopoutSeed(parsed)
  })
}
