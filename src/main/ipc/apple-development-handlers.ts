import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import type { ToolRegistry } from '../services/tool-registry.ts'
import {
  APPLE_SUGGESTION_ANSWERS,
  appleConfigureInputSchema,
  appleExecuteInputSchema,
  appleOperationInputSchema,
} from '@shared/types/apple-development.ts'
import {
  assertMainFrameSender,
  parseIpcArgs,
  zNonEmptyString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { getAppleDevelopmentService } from '../services/apple-development/apple-development-service.ts'
import { reloadMcpServers } from '../services/mcp/mcp-registry.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'

export function registerAppleDevelopmentHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  // Apple Development first-party plugin. Renderer requests carry only project/thread
  // identities; main resolves and validates the checkout before every operation.
  const appleInvocation = (
    projectId: string,
    threadId: string,
    signal: AbortSignal,
  ): { owner: { projectId: string; threadId: string }; source: 'user'; signal: AbortSignal } => ({
    owner: { projectId, threadId },
    source: 'user' as const,
    signal,
  })

  ipcMain.handle(
    'apple-development:state',
    async (event, rawProjectId: unknown, rawThreadId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [
        rawProjectId,
        rawThreadId,
      ])
      await resolveThreadExecutionContext(projectId, threadId)
      return getAppleDevelopmentService().getState({ projectId, threadId })
    },
  )
  ipcMain.handle('apple-development:detect-project', async (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    return getAppleDevelopmentService().detectProject(projectId)
  })
  ipcMain.handle('apple-development:suggestion', async (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    return getAppleDevelopmentService().projectSuggestion(projectId)
  })
  ipcMain.handle(
    'apple-development:answer-suggestion',
    async (event, rawProjectId: unknown, rawAnswer: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, answer] = parseIpcArgs(
        z.tuple([zProjectId, z.enum(APPLE_SUGGESTION_ANSWERS)]),
        [rawProjectId, rawAnswer],
      )
      await getAppleDevelopmentService().answerSuggestion(projectId, answer)
    },
  )
  ipcMain.handle(
    'apple-development:set-enrolled',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawEnrolled: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, enrolled] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.boolean()]),
        [rawProjectId, rawThreadId, rawEnrolled],
      )
      const controller = new AbortController()
      const state = await getAppleDevelopmentService().setEnrolled(
        appleInvocation(projectId, threadId, controller.signal),
        enrolled,
      )
      const statuses = await reloadMcpServers(registry)
      broadcastToAppWindows('mcp:status-changed', statuses)
      return state
    },
  )
  ipcMain.handle(
    'apple-development:discover',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawIncludeMetadata: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, includeMetadata] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.boolean()]),
        [rawProjectId, rawThreadId, rawIncludeMetadata],
      )
      const controller = new AbortController()
      return getAppleDevelopmentService().discover(
        appleInvocation(projectId, threadId, controller.signal),
        includeMetadata,
      )
    },
  )
  ipcMain.handle(
    'apple-development:configure',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawInput: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, input] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, appleConfigureInputSchema]),
        [rawProjectId, rawThreadId, rawInput],
      )
      const controller = new AbortController()
      return getAppleDevelopmentService().configure(
        appleInvocation(projectId, threadId, controller.signal),
        input,
      )
    },
  )
  ipcMain.handle(
    'apple-development:destinations',
    async (
      event,
      rawProjectId: unknown,
      rawThreadId: unknown,
      rawCandidateId: unknown,
      rawSchemeId: unknown,
    ) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, candidateId, schemeId] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zNonEmptyString.max(512), zNonEmptyString.max(256)]),
        [rawProjectId, rawThreadId, rawCandidateId, rawSchemeId],
      )
      const controller = new AbortController()
      return getAppleDevelopmentService().destinations(
        appleInvocation(projectId, threadId, controller.signal),
        candidateId,
        schemeId,
      )
    },
  )
  ipcMain.handle(
    'apple-development:execute',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawInput: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, input] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, appleExecuteInputSchema]),
        [rawProjectId, rawThreadId, rawInput],
      )
      const controller = new AbortController()
      return getAppleDevelopmentService().execute(
        appleInvocation(projectId, threadId, controller.signal),
        input,
      )
    },
  )
  ipcMain.handle(
    'apple-development:operation',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawInput: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, input] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, appleOperationInputSchema]),
        [rawProjectId, rawThreadId, rawInput],
      )
      const controller = new AbortController()
      const call = appleInvocation(projectId, threadId, controller.signal)
      if (input.action === 'cancel') {
        return getAppleDevelopmentService().cancel(call, input.operationId)
      }
      return getAppleDevelopmentService().operation(call, input.operationId, input.logCursor)
    },
  )
  ipcMain.handle(
    'apple-development:stop-app',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawAppSessionId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, appSessionId] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zNonEmptyString.max(256)]),
        [rawProjectId, rawThreadId, rawAppSessionId],
      )
      const controller = new AbortController()
      return getAppleDevelopmentService().stopApp(
        appleInvocation(projectId, threadId, controller.signal),
        appSessionId,
      )
    },
  )
}
