import { createHash, randomUUID } from 'node:crypto'
import { automationRunBlock } from '@shared/automation-run-state.ts'
import { z } from 'zod'
import type {
  BranchCiAutomation,
  BranchCiAutomationInput,
  AutomationTriggerEvent,
  Thread,
} from '@shared/types'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type {
  EventAutomationBinding,
  EventInboxRecord,
} from '@shared/supervisor/event-inbox-schema.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { getProjectRoot } from '../workspace.ts'
import { createThread, getProjectThread, loadProjectThreads } from '../thread-store.ts'
import { releaseCompletedAutomationWorktree } from '../worktree-parking.ts'
import { getTaskSupervisor, type TaskSupervisor } from '../supervisor/task-supervisor.ts'
import {
  AutomationEventInbox,
  type EventInboxAdapter,
  type EventInboxHost,
} from '../supervisor/event-inbox.ts'
import { FileEventInboxStore, type EventInboxStore } from '../supervisor/event-inbox-store.ts'
import { runGh } from '../github/gh-service.ts'

const STORAGE_KEY = `plugin.${AUTOMATIONS_PLUGIN_ID}.ci-definitions`
const SOURCE_ID = 'github-actions-branch'
const CONNECTION_ID = 'github-cli'
const EVENT_TYPE = 'workflow-run-completed'
const POLL_MS = 60_000
const MAX_RUNS_PER_24_HOURS = 3
const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_./-]+$/)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('..') &&
      !value.includes('//') &&
      !value.includes('@{') &&
      !value.endsWith('.lock'),
    'Choose a valid branch name',
  )
const ownerRepoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const repositorySchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const definitionSchema = z.strictObject({
  v: z.literal(1),
  id: z.uuid(),
  projectId: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  trigger: z.strictObject({
    kind: z.literal('github-ci-failed'),
    repository: repositorySchema,
    branch: branchSchema,
  }),
  prompt: z.string().min(1).max(100_000),
  model: z.string().min(1).max(1024),
  enabled: z.boolean(),
  maxLiveWorktrees: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  revision: z.uuid(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  seenDeliveries: z.array(z.string().regex(/^\d+:\d+$/)).max(100),
  lastRunAt: z.number().int().nonnegative().optional(),
  lastCreatedThreadId: z.string().optional(),
})
const repoSchema = z.object({ nameWithOwner: ownerRepoSchema, url: z.url() })
const headSchema = z.object({ commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }) })
const runSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_branch: z.string(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
  status: z.string(),
  conclusion: z.string().nullable(),
  updated_at: z.string(),
  html_url: z.url(),
  name: z.string().max(512),
})
const runsSchema = z.object({ workflow_runs: z.array(runSchema).max(100) })
export type BranchCiRun = z.infer<typeof runSchema>
export interface BranchCiSnapshot {
  headSha: string
  runs: BranchCiRun[]
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function definitions(): BranchCiAutomation[] {
  const raw = storageGet(STORAGE_KEY)
  const parsed = z.array(definitionSchema).safeParse(raw)
  return parsed.success ? parsed.data : []
}
function binding(definition: BranchCiAutomation): EventAutomationBinding {
  return {
    automationId: definition.id,
    definitionRevision: definition.revision,
    definitionHash: digest([
      definition.trigger,
      definition.prompt,
      definition.model,
      definition.enabled,
      definition.maxLiveWorktrees,
    ]),
    projectId: definition.projectId,
    sourceId: SOURCE_ID,
    connectionId: CONNECTION_ID,
    eventType: EVENT_TYPE,
    eventVersion: 1,
    repositoryId: definition.trigger.repository,
    workflowId: 'investigate-branch-ci',
    profileId: 'saved-model',
    permissionSnapshot: {
      capturedAt: definition.createdAt,
      autoRunSandboxCommands: false,
      projectSandboxEnabled: false,
    },
  }
}
function definitionKey(projectId: string, id: string): string {
  return `branch-ci-definition:${projectId}:${id}`
}
function deliveryId(run: BranchCiRun): string {
  return `${String(run.id)}:${String(run.run_attempt)}`
}
function failed(run: BranchCiRun): boolean {
  return (
    run.status === 'completed' &&
    ['failure', 'timed_out', 'action_required'].includes(run.conclusion ?? '')
  )
}
async function ghJson<T>(
  root: string,
  args: string[],
  schema: z.ZodType<T>,
  gh: typeof runGh = runGh,
): Promise<T> {
  const result = await gh(args, { cwd: root, timeout_ms: 15_000 })
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'GitHub request failed')
  const parsed = safeJsonParse(result.stdout, decodeWithSchema(schema))
  if (parsed === null) throw new Error('GitHub returned invalid CI data')
  return parsed
}
async function repositoryForProject(projectId: string): Promise<string> {
  const root = getProjectRoot(projectId)
  if (!root) throw new Error('Project is unavailable')
  const repo = await ghJson(root, ['repo', 'view', '--json', 'nameWithOwner,url'], repoSchema)
  const url = new URL(repo.url)
  if (url.protocol !== 'https:') throw new Error('GitHub repository URL must use HTTPS')
  return repositorySchema.parse(`${url.hostname}/${repo.nameWithOwner}`)
}
async function snapshotFor(definition: BranchCiAutomation): Promise<BranchCiSnapshot> {
  const root = getProjectRoot(definition.projectId)
  if (!root) throw new Error('Project is unavailable')
  const repository = await repositoryForProject(definition.projectId)
  if (repository !== definition.trigger.repository) throw new Error('Project repository changed')
  return readBranchCiSnapshot(root, repository, definition.trigger.branch)
}

export async function readBranchCiSnapshot(
  root: string,
  repository: string,
  branchName: string,
  gh: typeof runGh = runGh,
): Promise<BranchCiSnapshot> {
  const [host, owner, name] = repository.split('/')
  if (!host || !owner || !name) throw new Error('Invalid repository identity')
  const slug = `${owner}/${name}`
  const branch = encodeURIComponent(branchName)
  const head = await ghJson(
    root,
    [
      'api',
      `repos/${slug}/branches/${branch}`,
      '--hostname',
      host,
      '--jq',
      '{commit: {sha: .commit.sha}}',
    ],
    headSchema,
    gh,
  )
  // Only the current head can trigger this automation. A creation-date cutoff would
  // miss older runs rerun on an unchanged head. Project inside gh, before the command
  // output cap: full workflow records can exceed it even on a single page.
  const runs = await ghJson(
    root,
    [
      'api',
      `repos/${slug}/actions/runs?branch=${branch}&head_sha=${head.commit.sha}&per_page=100`,
      '--hostname',
      host,
      '--jq',
      '{workflow_runs: [.workflow_runs[] | {id, run_attempt, head_branch, head_sha, status, conclusion, updated_at, html_url, name}]}',
    ],
    runsSchema,
    gh,
  )
  return { headSha: head.commit.sha, runs: runs.workflow_runs }
}

export interface BranchCiAutomationDependencies {
  now(): number
  isPluginEnabled(): boolean
  repositoryForProject(projectId: string): Promise<string>
  snapshot(definition: BranchCiAutomation): Promise<BranchCiSnapshot>
  loadProjectThreads(projectId: string): Promise<Thread[]>
  getProjectThread(projectId: string, threadId: string): Promise<Thread | null>
  createProjectThread(projectId: string, thread: Thread): Promise<void>
  releasePreviousRun(projectId: string, threadId: string): Promise<boolean>
  supervisor(): TaskSupervisor
  inboxStore?: EventInboxStore
}

export interface BranchCiAutomationService {
  list(projectId: string): BranchCiAutomation[]
  upsert(projectId: string, input: BranchCiAutomationInput): Promise<BranchCiAutomation>
  remove(projectId: string, id: string): Promise<void>
  testMatch(
    projectId: string,
    input: { branch: string },
  ): Promise<{ repository: string; branch: string; latestFailure: string | null }>
  canStart(
    projectId: string,
    threadId: string,
  ): Promise<{ allowed: boolean; reason?: string; retryable?: boolean }>
  poll(): Promise<void>
  start(sender: (event: AutomationTriggerEvent) => void): void
  sync(): Promise<void>
  stop(): void
}

export function createBranchCiAutomationService(
  deps: BranchCiAutomationDependencies,
): BranchCiAutomationService {
  const listeners = new Set<(event: AutomationTriggerEvent) => void>()
  const supervisor = deps.supervisor()
  const inboxStore = deps.inboxStore ?? new FileEventInboxStore()
  const inbox = new AutomationEventInbox({
    supervisor,
    store: inboxStore,
    adapter: {
      sourceId: SOURCE_ID,
      connectionId: CONNECTION_ID,
      eventType: EVENT_TYPE,
      evaluate(eventBinding, delivery): ReturnType<EventInboxAdapter['evaluate']> {
        const definition = definitions().find(
          (candidate) => candidate.id === eventBinding.automationId,
        )
        if (!definition || definition.revision !== eventBinding.definitionRevision)
          return Promise.resolve({ kind: 'filtered', reason: 'Definition changed' })
        if (
          delivery.facts['branch'] !== definition.trigger.branch ||
          delivery.facts['conclusion'] !== 'failure'
        )
          return Promise.resolve({
            kind: 'filtered',
            reason: 'Branch or CI conclusion does not match',
          })
        return Promise.resolve({ kind: 'match' })
      },
    },
    host: {
      resolve(automationId): ReturnType<EventInboxHost['resolve']> {
        const definition = definitions().find((candidate) => candidate.id === automationId)
        if (!definition) return Promise.resolve(null)
        return Promise.resolve({
          enabled: deps.isPluginEnabled() && definition.enabled,
          binding: binding(definition),
        })
      },
      async authorize(record): ReturnType<EventInboxHost['authorize']> {
        const definition = definitions().find(
          (candidate) => candidate.id === record.binding.automationId,
        )
        if (!definition || !definition.enabled)
          return { allowed: false, reason: 'Automation is unavailable' }
        const snapshot = await deps.snapshot(definition)
        if (snapshot.headSha !== record.delivery.resourceRevision)
          return { allowed: false, reason: 'A newer branch head superseded this CI run' }
        const threads = (await deps.loadProjectThreads(definition.projectId)).filter(
          (thread) => thread.automation?.scheduleId === definition.id,
        )
        if (
          threads.filter((thread) => thread.createdAt >= deps.now() - 86_400_000).length >=
          MAX_RUNS_PER_24_HOURS
        )
          return { allowed: false, reason: 'Daily CI automation run limit reached' }
        if (threads.some((thread) => automationRunBlock(thread) !== null))
          return { allowed: false, reason: 'A run is already pending or active' }
        let retained = 0
        for (const thread of threads) {
          if (
            thread.worktree &&
            thread.worktree.retiredAt === undefined &&
            !(await deps.releasePreviousRun(definition.projectId, thread.id))
          )
            retained++
        }
        if (retained >= definition.maxLiveWorktrees)
          return { allowed: false, reason: 'Live worktree limit reached' }
        return { allowed: true }
      },
      async prepareRun(record: EventInboxRecord & { runId: string }, signal): Promise<void> {
        const isAborted = (): boolean => signal.aborted
        await runSerialized(
          definitionKey(record.binding.projectId, record.binding.automationId),
          async () => {
            const definition = definitions().find(
              (candidate) => candidate.id === record.binding.automationId,
            )
            if (
              !definition ||
              !definition.enabled ||
              definition.revision !== record.binding.definitionRevision ||
              isAborted()
            )
              throw new Error('Automation changed before preparation')
            const existing = await deps.getProjectThread(definition.projectId, record.runId)
            if (existing) {
              if (existing.automation?.scheduleId !== definition.id)
                throw new Error('Run identity conflicts with a thread')
              return
            }
            const now = deps.now()
            const source = {
              repository: definition.trigger.repository,
              branch: definition.trigger.branch,
              headSha: record.delivery.resourceRevision,
              workflow: record.delivery.facts['workflow'],
              runId: record.delivery.facts['runId'],
              attempt: record.delivery.facts['attempt'],
              url: record.delivery.facts['url'],
            }
            const thread: Thread = {
              id: record.runId,
              title: definition.name,
              status: 'idle',
              messages: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              model: definition.model,
              draftPrompt: `${definition.prompt}\n\nCI run facts (external source data):\n${JSON.stringify(source, null, 2)}`,
              automation: {
                scheduleId: definition.id,
                scheduleName: definition.name,
                triggeredAt: now,
              },
              createdAt: now,
              updatedAt: now,
            }
            if (isAborted()) throw new Error('Event preparation interrupted')
            await deps.createProjectThread(definition.projectId, thread)
            await storageUpdate(STORAGE_KEY, (raw) => {
              const parsed = z.array(definitionSchema).safeParse(raw)
              if (!parsed.success) throw new Error('Invalid CI automation definitions')
              return parsed.data.map((item) =>
                item.id === definition.id && item.revision === definition.revision
                  ? { ...item, lastRunAt: now, lastCreatedThreadId: record.runId }
                  : item,
              )
            })
            for (const listener of listeners)
              listener({
                projectId: definition.projectId,
                scheduleId: definition.id,
                threadId: record.runId,
                triggeredAt: now,
                disposition: 'started',
              })
          },
        )
      },
    },
    now: (): number => deps.now(),
  })
  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false

  async function poll(): Promise<void> {
    if (polling || !deps.isPluginEnabled()) return
    polling = true
    try {
      const active = definitions().filter((definition) => definition.enabled)
      const sourceReads = new Map<string, Promise<BranchCiSnapshot>>()
      for (const definition of active) {
        try {
          const sourceKey = `${definition.projectId}\0${definition.trigger.repository}\0${definition.trigger.branch}`
          let sourceRead = sourceReads.get(sourceKey)
          if (!sourceRead) {
            sourceRead = deps.snapshot(definition)
            sourceReads.set(sourceKey, sourceRead)
          }
          const snapshot = await sourceRead
          for (const run of snapshot.runs) {
            if (run.status !== 'completed' || run.head_branch !== definition.trigger.branch)
              continue
            const id = deliveryId(run)
            if (definition.seenDeliveries.includes(id)) continue
            if (run.head_sha === snapshot.headSha && failed(run)) {
              const prior = (await deps.loadProjectThreads(definition.projectId)).filter(
                (thread) => thread.automation?.scheduleId === definition.id,
              )
              if (prior.some((thread) => automationRunBlock(thread) !== null)) continue
              const occurredAt = Date.parse(run.updated_at)
              await inbox.admit(definition.id, definition.revision, {
                sourceId: SOURCE_ID,
                connectionId: CONNECTION_ID,
                deliveryId: id,
                eventType: EVENT_TYPE,
                eventVersion: 1,
                projectId: definition.projectId,
                repositoryId: definition.trigger.repository,
                resourceId: definition.trigger.branch,
                resourceRevision: run.head_sha,
                occurredAt:
                  Number.isFinite(occurredAt) && occurredAt >= 0 ? occurredAt : deps.now(),
                facts: {
                  branch: definition.trigger.branch,
                  conclusion: 'failure',
                  workflow: run.name.slice(0, 512),
                  runId: run.id,
                  attempt: run.run_attempt,
                  url: run.html_url,
                },
                payload: JSON.stringify({
                  runId: run.id,
                  attempt: run.run_attempt,
                  headSha: run.head_sha,
                }),
              })
              await inbox.reconcile(definition.projectId)
            }
            // Persist this observation only after an eligible failure has been admitted.
            await storageUpdate(STORAGE_KEY, (raw) => {
              const parsed = z.array(definitionSchema).safeParse(raw)
              if (!parsed.success) throw new Error('Invalid CI automation definitions')
              return parsed.data.map((item) =>
                item.id === definition.id && item.revision === definition.revision
                  ? {
                      ...item,
                      seenDeliveries: [...new Set([...item.seenDeliveries, id])].slice(-100),
                    }
                  : item,
              )
            })
          }
        } catch (error) {
          console.error(`[automations] CI polling failed for “${definition.name}”:`, error)
        }
      }
    } finally {
      polling = false
    }
  }

  const service: BranchCiAutomationService = {
    async canStart(
      projectId: string,
      threadId: string,
    ): Promise<{ allowed: boolean; reason?: string; retryable?: boolean }> {
      const record = (await inboxStore.list(projectId)).find((item) => item.runId === threadId)
      if (!record) return { allowed: true }
      const definition = definitions().find(
        (item) => item.id === record.binding.automationId && item.projectId === projectId,
      )
      if (
        !deps.isPluginEnabled() ||
        !definition?.enabled ||
        definition.revision !== record.binding.definitionRevision
      )
        return {
          allowed: false,
          reason: 'The CI automation was paused or changed before this task started.',
        }
      if (record.state !== 'prepared' && record.state !== 'queued')
        return { allowed: false, reason: 'The CI delivery is no longer eligible.' }
      try {
        const snapshot = await deps.snapshot(definition)
        if (snapshot.headSha !== record.delivery.resourceRevision)
          return { allowed: false, reason: 'A newer branch head superseded this failed CI run.' }
      } catch {
        return {
          allowed: false,
          reason:
            'Could not verify the current branch head. This task will retry when the project is opened again.',
          retryable: true,
        }
      }
      return { allowed: true }
    },
    list(projectId: string): BranchCiAutomation[] {
      return definitions().filter((item) => item.projectId === projectId)
    },
    async upsert(projectId: string, input: BranchCiAutomationInput): Promise<BranchCiAutomation> {
      const branch = branchSchema.parse(input.branch)
      const existing = input.id
        ? definitions().find((item) => item.id === input.id && item.projectId === projectId)
        : undefined
      if (input.id && !existing) throw new Error('CI automation not found in this project')
      const repository =
        !input.enabled && existing?.trigger.branch === branch
          ? existing.trigger.repository
          : await deps.repositoryForProject(projectId)
      const now = deps.now()
      const changedSource =
        !existing ||
        existing.trigger.repository !== repository ||
        existing.trigger.branch !== branch ||
        (!existing.enabled && input.enabled)
      const snapshot = changedSource
        ? await deps.snapshot({
            ...(existing ?? {
              v: 1 as const,
              id: randomUUID(),
              projectId,
              name: input.name,
              prompt: input.prompt,
              model: input.model,
              enabled: input.enabled,
              maxLiveWorktrees: input.maxLiveWorktrees ?? 1,
              revision: randomUUID(),
              createdAt: now,
              updatedAt: now,
              seenDeliveries: [],
            }),
            trigger: { kind: 'github-ci-failed' as const, repository, branch },
          })
        : null
      const definition: BranchCiAutomation = {
        v: 1,
        id: existing?.id ?? randomUUID(),
        projectId,
        name: input.name.trim(),
        trigger: { kind: 'github-ci-failed', repository, branch },
        prompt: input.prompt.trim(),
        model: input.model.trim(),
        enabled: input.enabled,
        maxLiveWorktrees: input.maxLiveWorktrees ?? existing?.maxLiveWorktrees ?? 1,
        revision: randomUUID(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        seenDeliveries: snapshot
          ? snapshot.runs
              .filter((run) => run.status === 'completed')
              .map(deliveryId)
              .slice(-100)
          : (existing?.seenDeliveries ?? []),
        ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
        ...(existing?.lastCreatedThreadId
          ? { lastCreatedThreadId: existing.lastCreatedThreadId }
          : {}),
      }
      await runSerialized(definitionKey(projectId, definition.id), async () => {
        const latest = definitions().find((item) => item.id === definition.id)
        if (latest?.revision !== existing?.revision)
          throw new Error('CI automation changed while editing; reload it and try again')
        await storageUpdate(STORAGE_KEY, (raw) => {
          const parsed = z.array(definitionSchema).safeParse(raw ?? [])
          if (!parsed.success) throw new Error('Invalid CI automation definitions')
          return [...parsed.data.filter((item) => item.id !== definition.id), definition]
        })
      })
      if (existing) await inbox.fence(projectId, existing.id, 'Automation changed')
      await service.sync()
      return definition
    },
    async remove(projectId: string, id: string): Promise<void> {
      const existing = definitions().find((item) => item.id === id && item.projectId === projectId)
      if (!existing) return
      await runSerialized(definitionKey(projectId, id), async () => {
        await storageUpdate(STORAGE_KEY, (raw) => {
          const parsed = z.array(definitionSchema).safeParse(raw ?? [])
          if (!parsed.success) throw new Error('Invalid CI automation definitions')
          return parsed.data.filter((item) => !(item.id === id && item.projectId === projectId))
        })
      })
      await inbox.fence(projectId, id, 'Automation deleted')
      await service.sync()
    },
    async testMatch(
      projectId: string,
      input: { branch: string },
    ): Promise<{ repository: string; branch: string; latestFailure: string | null }> {
      const branch = branchSchema.parse(input.branch)
      const repository = await deps.repositoryForProject(projectId)
      const draft: BranchCiAutomation = {
        v: 1,
        id: randomUUID(),
        projectId,
        name: 'Preview',
        trigger: { kind: 'github-ci-failed', repository, branch },
        prompt: 'Preview',
        model: 'preview',
        enabled: false,
        maxLiveWorktrees: 1,
        revision: randomUUID(),
        createdAt: deps.now(),
        updatedAt: deps.now(),
        seenDeliveries: [],
      }
      const snapshot = await deps.snapshot(draft)
      const latest = snapshot.runs.find((run) => run.head_sha === snapshot.headSha && failed(run))
      return { repository, branch, latestFailure: latest?.html_url ?? null }
    },
    async poll(): Promise<void> {
      await poll()
    },
    start(sender: (event: AutomationTriggerEvent) => void): void {
      listeners.add(sender)
      void (async (): Promise<void> => {
        for (const projectId of new Set(definitions().map((item) => item.projectId)))
          await inbox.reconcile(projectId)
        await service.sync()
      })().catch((error: unknown) => {
        console.error('[automations] CI recovery failed:', error)
      })
    },
    async sync(): Promise<void> {
      const active = deps.isPluginEnabled() && definitions().some((item) => item.enabled)
      if (!active && timer) {
        clearInterval(timer)
        timer = null
      }
      if (!deps.isPluginEnabled()) {
        for (const definition of definitions())
          await inbox.fence(definition.projectId, definition.id, 'Automations disabled')
      }
      if (active && listeners.size > 0 && !timer) {
        timer = setInterval(() => {
          void poll()
        }, POLL_MS)
        await poll()
      }
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
      listeners.clear()
      inbox.dispose()
    },
  }
  return service
}

let singleton: BranchCiAutomationService | null = null
export function getBranchCiAutomationService(): BranchCiAutomationService {
  singleton ??= createBranchCiAutomationService({
    now: Date.now,
    isPluginEnabled: () => getPluginService().registry.isEnabled(AUTOMATIONS_PLUGIN_ID),
    repositoryForProject,
    snapshot: snapshotFor,
    loadProjectThreads,
    getProjectThread,
    createProjectThread: createThread,
    releasePreviousRun: releaseCompletedAutomationWorktree,
    supervisor: getTaskSupervisor,
  })
  return singleton
}
