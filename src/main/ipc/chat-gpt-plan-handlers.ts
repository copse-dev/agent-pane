import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import { getChatGptPlanService } from '../services/providers/chatgpt-plan-service.ts'

const zAccountId = z.string().min(1).max(256)

export function registerChatGptPlanHandlers(win: BrowserWindow): void {
  defineHandler(win, 'chat-gpt-plan:status', z.tuple([]), () => getChatGptPlanService().status())
  defineHandler(win, 'chat-gpt-plan:sign-in', z.tuple([zAccountId.optional()]), (accountId) =>
    getChatGptPlanService().signIn(accountId),
  )
  defineHandler(win, 'chat-gpt-plan:refresh-account', z.tuple([zAccountId]), (accountId) =>
    getChatGptPlanService().refreshAccount(accountId),
  )
  defineHandler(win, 'chat-gpt-plan:cancel-sign-in', z.tuple([]), () => {
    getChatGptPlanService().cancelSignIn()
  })
  defineHandler(win, 'chat-gpt-plan:select-account', z.tuple([zAccountId]), (accountId) =>
    getChatGptPlanService().selectAccount(accountId),
  )
  defineHandler(win, 'chat-gpt-plan:sign-out', z.tuple([zAccountId]), (accountId) =>
    getChatGptPlanService().signOut(accountId),
  )
  defineHandler(win, 'chat-gpt-plan:models', z.tuple([]), () => getChatGptPlanService().models())
}
