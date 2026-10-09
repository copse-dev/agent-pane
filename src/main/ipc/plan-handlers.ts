import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'
import {
  getLatestThreadPlan,
  getThreadPlanRevision,
  createThreadPlan,
  reviseThreadPlan,
  commentOnThreadPlan,
  approveThreadPlan,
  abandonThreadPlan,
} from '../services/thread-store.ts'

const ownerSchema = z.tuple([zProjectId, zThreadId])
const draft = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(100000),
})
const identity = { planId: z.uuid(), revision: z.number().int().positive() }
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), ...draft.shape }),
  z.object({ action: z.literal('revise'), ...identity, ...draft.shape }),
  z.object({
    action: z.literal('comment'),
    ...identity,
    body: z.string().trim().min(1).max(10000),
    anchor: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  }),
  z.object({
    action: z.literal('approve'),
    ...identity,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({ action: z.literal('abandon'), ...identity }),
])
export function registerPlanHandlers(
  win: BrowserWindow,
  isActive: (projectId: string, threadId: string) => boolean,
): void {
  ipcMain.handle('plans:get', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [project, thread] = parseIpcArgs(ownerSchema, [projectId, threadId])
    return getLatestThreadPlan(project, thread)
  })
  ipcMain.handle(
    'plans:revision',
    (event, projectId: unknown, threadId: unknown, planId: unknown, revision: unknown) => {
      assertMainFrameSender(event, win)
      const [project, thread, plan, rev] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, identity.planId, identity.revision]),
        [projectId, threadId, planId, revision],
      )
      return getThreadPlanRevision(project, thread, plan, rev)
    },
  )
  ipcMain.handle(
    'plans:change',
    async (event, projectId: unknown, threadId: unknown, input: unknown) => {
      assertMainFrameSender(event, win)
      const [project, thread, change] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, actionSchema]),
        [projectId, threadId, input],
      )
      const options = {
        assertIdle: (): void => {
          if (isActive(project, thread))
            throw new Error('Wait for the current turn to finish before changing the plan')
        },
      }
      options.assertIdle()
      switch (change.action) {
        case 'create':
          return createThreadPlan(project, thread, change, options)
        case 'revise':
          return reviseThreadPlan(project, thread, change.planId, change.revision, change, options)
        case 'approve':
          return approveThreadPlan(
            project,
            thread,
            change.planId,
            change.revision,
            change.contentHash,
            'implementation',
            options,
          )
        case 'abandon':
          return abandonThreadPlan(project, thread, change.planId, change.revision, options)
        case 'comment': {
          await commentOnThreadPlan(
            project,
            thread,
            change.planId,
            change.revision,
            change.body,
            change.anchor,
            options,
          )
          return getLatestThreadPlan(project, thread)
        }
      }
    },
  )
}
