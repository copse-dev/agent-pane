import { containerRunRequestSchema } from '@shared/container-run-schema.ts'
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import {
  assertMainFrameSender,
  parseIpcArgs,
  zNonEmptyString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { zGuardedYoloThreadId } from './security-handler-args.ts'
import { getLatestThreadPlan } from '../services/thread-store.ts'
import { getContainerRunService } from '../services/container-runtime/container-run-service.ts'
import { explainContainerModel } from '../services/providers/container-provider.ts'

export function registerContainerHandlers(
  win: BrowserWindow,
  startingContainerThreads: Set<string>,
): void {
  // Unattended container runs (docs/plans/thread-in-container.md). The
  // renderer sends the prompt, the model and the budgets; the main process
  // resolves the checkout, the provider and its key, and owns the run.
  ipcMain.handle('container:run-thread', async (event, request: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(containerRunRequestSchema, [request])
    const [projectId, threadId] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [
      parsed.projectId,
      parsed.threadId,
    ])
    if (startingContainerThreads.has(threadId))
      throw new Error('A container run is already starting')
    startingContainerThreads.add(threadId)
    try {
      const activePlan = await getLatestThreadPlan(projectId, threadId)
      if (activePlan && activePlan.meta.status !== 'abandoned') {
        throw new Error(
          'Container runs cannot enforce the plan workflow. End the plan before starting a container run.',
        )
      }
      return await getContainerRunService().start({
        projectId,
        threadId,
        prompt: parsed.prompt,
        model: parsed.model,
        budgets: parsed.budgets,
        ...(parsed.useAgentLogin !== undefined ? { useAgentLogin: parsed.useAgentLogin } : {}),
        ...(parsed.installDependencies !== undefined
          ? { installDependencies: parsed.installDependencies }
          : {}),
        ...(parsed.continueFrom !== undefined ? { continueFrom: parsed.continueFrom } : {}),
        ...(parsed.continueContext !== undefined
          ? { continueContext: parsed.continueContext }
          : {}),
      })
    } finally {
      startingContainerThreads.delete(threadId)
    }
  })
  // Why each model could not run in a container, or null when it could — the
  // resolver's own answer, so the dialog's greyed rows never disagree with a
  // refused start about which key counts (Settings or the environment).
  ipcMain.handle('container:model-availability', async (event, models: unknown) => {
    assertMainFrameSender(event, win)
    const list = parseIpcArgs(z.array(zNonEmptyString.max(256)).max(512), [models])
    const verdicts = await Promise.all(list.map((model) => explainContainerModel(model)))
    return Object.fromEntries(list.map((model, index) => [model, verdicts[index]]))
  })
  ipcMain.handle('container:get-run', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    return getContainerRunService().get(id)
  })
  ipcMain.handle('container:stop-run', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    return getContainerRunService().stop(id)
  })
  // Follow up on a finished run: its commits, cherry-picked onto the thread's
  // checkout. The runtime id names the record on disk, so it works for a run
  // an earlier app session made; the thread must be the one that ran it.
  ipcMain.handle(
    'container:adopt-run',
    (event, projectId: unknown, threadId: unknown, runtimeId: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, rid] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().regex(/^[a-z0-9-]{1,128}$/i)]),
        [projectId, threadId, runtimeId],
      )
      return getContainerRunService().adopt(pid, tid, rid)
    },
  )
}
