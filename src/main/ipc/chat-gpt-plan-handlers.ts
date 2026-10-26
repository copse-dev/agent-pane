import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import { getChatGptPlanService } from '../services/providers/chatgpt-plan-service.ts'

export function registerChatGptPlanHandlers(win: BrowserWindow): void {
  ipcMain.handle('chat-gpt-plan:status', (event) => {
    assertMainFrameSender(event, win)
    return getChatGptPlanService().status()
  })
  ipcMain.handle('chat-gpt-plan:sign-in', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return getChatGptPlanService().signIn(
      parseIpcArgs(z.string().min(1).max(256).optional(), [raw]),
    )
  })
  ipcMain.handle('chat-gpt-plan:refresh-account', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return getChatGptPlanService().refreshAccount(parseIpcArgs(z.string().min(1).max(256), [raw]))
  })
  ipcMain.handle('chat-gpt-plan:cancel-sign-in', (event) => {
    assertMainFrameSender(event, win)
    getChatGptPlanService().cancelSignIn()
  })
  ipcMain.handle('chat-gpt-plan:select-account', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return getChatGptPlanService().selectAccount(parseIpcArgs(z.string().min(1).max(256), [raw]))
  })
  ipcMain.handle('chat-gpt-plan:sign-out', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return getChatGptPlanService().signOut(parseIpcArgs(z.string().min(1).max(256), [raw]))
  })
  ipcMain.handle('chat-gpt-plan:models', (event) => {
    assertMainFrameSender(event, win)
    return getChatGptPlanService().models()
  })
}
