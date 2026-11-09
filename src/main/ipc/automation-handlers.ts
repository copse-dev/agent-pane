import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { AUTOMATION_FAILURE_CODES } from '@shared/types/automations.ts'
import { assertMainFrameSender, parseIpcArgs, zNonEmptyString, zProjectId } from './ipc-guards.ts'
import { getAutomationService } from '../services/automations/automation-service.ts'
import { getBranchCiAutomationService } from '../services/automations/branch-ci-automation-service.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'

const zAutomationPermission = z.union([
  z.object({
    kind: z.enum(['copse-action', 'mcp-tool']),
    toolName: z.string().trim().min(1).max(512),
  }),
  z.object({
    kind: z.literal('worktree-preparation'),
    toolName: z.literal('prepare_worktree'),
    directory: z.string().min(1).max(4096),
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    offline: z.boolean(),
  }),
])

const zAutomationScheduleInput = z.object({
  id: z.string().min(1).max(256).optional(),
  name: z.string().trim().min(1).max(160),
  cron: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(1024),
  enabled: z.boolean(),
  maxLiveWorktrees: z
    .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.literal('unlimited')])
    .optional(),
  permissions: z.array(zAutomationPermission).max(256).optional(),
})

const zEventTriggerInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('github-ci-failed'),
    branch: z.string().trim().min(1).max(200).optional(),
    checks: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    pullRequest: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('github-pr-changed'),
    baseBranch: z.string().trim().min(1).max(200),
    transition: z.enum(['ready-for-review', 'new-commits']),
  }),
  z.strictObject({
    kind: z.literal('github-issue-labeled'),
    label: z.string().trim().min(1).max(50),
  }),
])

const zAutomationFailureReport = z.strictObject({
  code: z.enum(AUTOMATION_FAILURE_CODES),
  message: z.string().trim().min(1).max(2000),
})

const zBranchCiAutomationInput = z.strictObject({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(160),
  branch: z.string().trim().min(1).max(200).optional(),
  trigger: zEventTriggerInput.optional(),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(1024),
  enabled: z.boolean(),
  maxLiveWorktrees: z
    .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.literal('unlimited')])
    .optional(),
})

export function registerAutomationHandlers(win: BrowserWindow): void {
  // Local cron automation prototype (`copse.automations`). Every operation is
  // project-scoped; the service repeats that ownership check for update/delete
  // so a renderer cannot address a schedule through another project id.
  ipcMain.handle('automations:list', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    return getAutomationService().list(projectId)
  })
  ipcMain.handle('automations:permission-options', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    parseIpcArgs(zProjectId, [rawProjectId])
    return getAutomationService().permissionOptions()
  })
  ipcMain.handle(
    'automations:review-preparation',
    (event, rawProjectId: unknown, rawInput: unknown) => {
      assertMainFrameSender(event, win)
      const projectId = parseIpcArgs(zProjectId, [rawProjectId])
      const input = parseIpcArgs(
        z.object({
          directory: z.string().trim().min(1).max(4096).optional(),
          offline: z.boolean().optional(),
        }),
        [rawInput],
      )
      return getAutomationService().reviewPreparation(projectId, {
        ...(input.directory !== undefined ? { directory: input.directory } : {}),
        ...(input.offline !== undefined ? { offline: input.offline } : {}),
      })
    },
  )
  ipcMain.handle('automations:upsert', async (event, rawProjectId: unknown, rawInput: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    const input = parseIpcArgs(zAutomationScheduleInput, [rawInput])
    if (
      !(await confirmNativeAction(event.sender, {
        title: 'Save automation?',
        detail: `Project: ${JSON.stringify(getProjectRoot(projectId))}\n\nThis automation may run unattended. Confirm its schedule, prompt, model and permissions:\n\n${JSON.stringify(input, null, 2)}`,
        approveLabel: 'Save automation',
      }))
    )
      throw new Error('Automation was not confirmed')
    return getAutomationService().upsert(projectId, {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      model: input.model,
      enabled: input.enabled,
      ...(input.maxLiveWorktrees !== undefined ? { maxLiveWorktrees: input.maxLiveWorktrees } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    })
  })
  ipcMain.handle(
    'automations:remove',
    async (event, rawProjectId: unknown, rawScheduleId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, scheduleId] = parseIpcArgs(
        z.tuple([zProjectId, zNonEmptyString.max(256)]),
        [rawProjectId, rawScheduleId],
      )
      await getAutomationService().remove(projectId, scheduleId)
    },
  )
  ipcMain.handle(
    'automations:run-now',
    async (event, rawProjectId: unknown, rawScheduleId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, scheduleId] = parseIpcArgs(
        z.tuple([zProjectId, zNonEmptyString.max(256)]),
        [rawProjectId, rawScheduleId],
      )
      const schedule = getAutomationService()
        .list(projectId)
        .find((item) => item.id === scheduleId)
      if (!schedule) throw new Error('Automation no longer exists')
      if (
        !(await confirmNativeAction(event.sender, {
          title: 'Run automation now?',
          detail: `Project: ${JSON.stringify(getProjectRoot(projectId))}\n\nRun this automation now?\n\n${JSON.stringify(schedule, null, 2)}`,
          approveLabel: 'Run automation',
        }))
      )
        throw new Error('Automation run was not confirmed')
      return getAutomationService().runNow(projectId, scheduleId)
    },
  )

  ipcMain.handle(
    'automations:cleanup-runs',
    async (event, rawProjectId: unknown, rawScheduleId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, scheduleId] = parseIpcArgs(
        z.tuple([zProjectId, zNonEmptyString.max(256)]),
        [rawProjectId, rawScheduleId],
      )
      return getAutomationService().cleanupRuns(projectId, scheduleId)
    },
  )

  ipcMain.handle('automations:list-branch-ci', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    return getBranchCiAutomationService().list(projectId)
  })
  ipcMain.handle(
    'automations:upsert-branch-ci',
    async (event, rawProjectId: unknown, rawInput: unknown) => {
      assertMainFrameSender(event, win)
      const projectId = parseIpcArgs(zProjectId, [rawProjectId])
      const input = parseIpcArgs(zBranchCiAutomationInput, [rawInput])
      if (
        !(await confirmNativeAction(event.sender, {
          title: 'Save event automation?',
          detail: `Project: ${JSON.stringify(getProjectRoot(projectId))}\n\nThis automation may run unattended when its trigger matches. Confirm its trigger, prompt and model:\n\n${JSON.stringify(input, null, 2)}`,
          approveLabel: 'Save automation',
        }))
      )
        throw new Error('Event automation was not confirmed')
      return getBranchCiAutomationService().upsert(projectId, {
        ...(input.id ? { id: input.id } : {}),
        name: input.name,
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        prompt: input.prompt,
        model: input.model,
        enabled: input.enabled,
        ...(input.maxLiveWorktrees ? { maxLiveWorktrees: input.maxLiveWorktrees } : {}),
      })
    },
  )
  ipcMain.handle(
    'automations:remove-branch-ci',
    async (event, rawProjectId: unknown, rawId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, id] = parseIpcArgs(z.tuple([zProjectId, z.uuid()]), [rawProjectId, rawId])
      await getBranchCiAutomationService().remove(projectId, id)
    },
  )
  ipcMain.handle(
    'automations:test-branch-ci',
    async (event, rawProjectId: unknown, rawTrigger: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, trigger] = parseIpcArgs(
        z.tuple([zProjectId, z.union([z.string().trim().min(1).max(200), zEventTriggerInput])]),
        [rawProjectId, rawTrigger],
      )
      return getBranchCiAutomationService().testMatch(
        projectId,
        typeof trigger === 'string' ? { branch: trigger } : { trigger },
      )
    },
  )
  ipcMain.handle(
    'automations:event-history',
    async (event, rawProjectId: unknown, rawId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, id] = parseIpcArgs(z.tuple([zProjectId, z.uuid()]), [rawProjectId, rawId])
      return getBranchCiAutomationService().history(projectId, id)
    },
  )
  // The renderer reports what it saw while starting a run; main accepts it only for the
  // latest run of a saved automation, so a stale or forged thread id changes nothing.
  ipcMain.handle(
    'automations:report-start-failure',
    async (event, rawProjectId: unknown, rawThreadId: unknown, rawFailure: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, failure] = parseIpcArgs(
        z.tuple([zProjectId, zNonEmptyString.max(256), zAutomationFailureReport]),
        [rawProjectId, rawThreadId, rawFailure],
      )
      return (
        (await getAutomationService().reportStartFailure(projectId, threadId, failure)) ||
        (await getBranchCiAutomationService().reportStartFailure(projectId, threadId, failure))
      )
    },
  )
  ipcMain.handle('automations:scheduler-health', (event) => {
    assertMainFrameSender(event, win)
    return getAutomationService().health()
  })

  ipcMain.handle(
    'automations:can-start',
    async (event, rawProjectId: unknown, rawThreadId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId] = parseIpcArgs(z.tuple([zProjectId, zNonEmptyString.max(256)]), [
        rawProjectId,
        rawThreadId,
      ])
      return getBranchCiAutomationService().canStart(projectId, threadId)
    },
  )
}
