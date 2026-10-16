import { createHash, randomUUID } from 'node:crypto'
import { automationRunBlock } from '@shared/automation-run-state.ts'
import { z } from 'zod'
import type {
  AutomationFailureCode,
  AutomationProblem,
  BranchCiAutomation,
  BranchCiAutomationInput,
  AutomationTriggerEvent,
  EventAutomationTrigger,
  EventAutomationTriggerInput,
  EventDeliverySummary,
  EventMatchPreview,
  Thread,
} from '@shared/types'
import {
  LABEL_PATTERN,
  readIssueHasLabel,
  readLabelEvents,
  readOpenPullRequests,
  readPullRequestHead,
  type LabelEventObservation,
  type PullRequestHead,
  type PullRequestObservation,
} from './github-event-sources.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type {
  AutomationDelivery,
  EventAutomationBinding,
  EventInboxRecord,
} from '@shared/supervisor/event-inbox-schema.ts'
import { classifyAutomationFailureMessage } from '@shared/automation-failure.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { getProjectRoot } from '../workspace.ts'
import { createThread, getProjectThread, loadProjectThreads } from '../thread-store.ts'
import {
  releaseCompletedAutomationWorktree,
  type AutomationWorktreeRelease,
} from '../worktree-parking.ts'
import { getAutomationWorktreeReuse } from '../automation-worktree-reuse.ts'
import { getTaskSupervisor, type TaskSupervisor } from '../supervisor/task-supervisor.ts'
import {
  AutomationEventInbox,
  type EventInboxAdapter,
  type EventInboxHost,
} from '../supervisor/event-inbox.ts'
import { FileEventInboxStore, type EventInboxStore } from '../supervisor/event-inbox-store.ts'
import { runGh } from '../github/gh-service.ts'

const STORAGE_KEY = `plugin.${AUTOMATIONS_PLUGIN_ID}.ci-definitions`
const CONNECTION_ID = 'github-cli'
/** The inbox identity of each trigger kind. The CI pair predates the other kinds and must not change. */
const ROUTES = {
  'github-ci-failed': { sourceId: 'github-actions-branch', eventType: 'workflow-run-completed' },
  'github-pr-changed': { sourceId: 'github-pull-requests', eventType: 'pull-request-changed' },
  'github-issue-labeled': { sourceId: 'github-issues', eventType: 'issue-labeled' },
} as const
const WORKFLOW_IDS = {
  'github-ci-failed': 'investigate-branch-ci',
  'github-pr-changed': 'review-pull-request',
  'github-issue-labeled': 'triage-issue',
} as const
const MAX_CHECK_FILTERS = 10
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
  trigger: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('github-ci-failed'),
      repository: repositorySchema,
      branch: branchSchema,
      checks: z.array(z.string().trim().min(1).max(200)).max(MAX_CHECK_FILTERS).optional(),
      pullRequest: z.number().int().positive().optional(),
    }),
    z.strictObject({
      kind: z.literal('github-pr-changed'),
      repository: repositorySchema,
      baseBranch: branchSchema,
      transition: z.enum(['ready-for-review', 'new-commits']),
    }),
    z.strictObject({
      kind: z.literal('github-issue-labeled'),
      repository: repositorySchema,
      label: z.string().regex(LABEL_PATTERN),
    }),
  ]),
  prompt: z.string().min(1).max(100_000),
  model: z.string().min(1).max(1024),
  enabled: z.boolean(),
  maxLiveWorktrees: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  revision: z.uuid(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  seenDeliveries: z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/)).max(100),
  draftPullRequests: z.array(z.number().int().positive()).max(100).optional(),
  lastRunAt: z.number().int().nonnegative().optional(),
  lastCreatedThreadId: z.string().optional(),
  lastProblem: z
    .strictObject({
      at: z.number().int().nonnegative(),
      kind: z.enum(['failed', 'pending-start']),
      message: z.string().max(2000),
      code: z
        .enum([
          'approval-stalled',
          'no-model',
          'container-missing',
          'auth-expired',
          'worktree-failed',
          'scheduler-stopped',
          'unknown',
        ])
        .optional(),
      threadId: z.string().max(160).optional(),
    })
    .optional(),
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
function readableDefinitions(raw: unknown): {
  readable: BranchCiAutomation[]
  unreadable: unknown[]
} {
  const rows: unknown[] = Array.isArray(raw) ? raw : []
  const readable: BranchCiAutomation[] = []
  const unreadable: unknown[] = []
  for (const row of rows) {
    const parsed = definitionSchema.safeParse(row)
    if (parsed.success) readable.push(parsed.data)
    else unreadable.push(row)
  }
  return { readable, unreadable }
}

/** One damaged definition must not hide, stop or block edits to the others. */
function definitions(): BranchCiAutomation[] {
  return readableDefinitions(storageGet(STORAGE_KEY)).readable
}

/** Rewrite the readable definitions while carrying rows this version cannot read through untouched. */
function updateDefinitions(
  update: (current: BranchCiAutomation[]) => BranchCiAutomation[],
): Promise<void> {
  return storageUpdate(STORAGE_KEY, (raw) => {
    const { readable, unreadable } = readableDefinitions(raw)
    return [...unreadable, ...update(readable)]
  })
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
    sourceId: ROUTES[definition.trigger.kind].sourceId,
    connectionId: CONNECTION_ID,
    eventType: ROUTES[definition.trigger.kind].eventType,
    eventVersion: 1,
    repositoryId: definition.trigger.repository,
    workflowId: WORKFLOW_IDS[definition.trigger.kind],
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
  if (definition.trigger.kind !== 'github-ci-failed')
    throw new Error('Only CI triggers read workflow runs')
  if (definition.trigger.pullRequest !== undefined)
    return readPullRequestCiSnapshot(root, repository, definition.trigger.pullRequest)
  return readBranchCiSnapshot(root, repository, definition.trigger.branch)
}

/** Workflow runs on a pull request's current head. The PR must still be open. */
export async function readPullRequestCiSnapshot(
  root: string,
  repository: string,
  pullRequest: number,
  gh: typeof runGh = runGh,
): Promise<BranchCiSnapshot> {
  const [host, owner, name] = repository.split('/')
  if (!host || !owner || !name) throw new Error('Invalid repository identity')
  const pr = await readPullRequestHead(root, repository, pullRequest, gh)
  if (pr.state !== 'open') throw new Error(`Pull request #${String(pullRequest)} is not open`)
  const runs = await ghJson(
    root,
    [
      'api',
      `repos/${owner}/${name}/actions/runs?head_sha=${pr.head.sha}&per_page=100`,
      '--hostname',
      host,
      '--jq',
      '{workflow_runs: [.workflow_runs[] | {id, run_attempt, head_branch, head_sha, status, conclusion, updated_at, html_url, name}]}',
    ],
    runsSchema,
    gh,
  )
  return { headSha: pr.head.sha, runs: runs.workflow_runs }
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
  /** Open pull requests into the definition's base branch. Required for pull-request triggers. */
  pullRequests?(definition: BranchCiAutomation): Promise<PullRequestObservation[]>
  /** Current state of one pull request. Required for pull-request triggers and PR-scoped CI. */
  pullRequestHead?(definition: BranchCiAutomation, pullRequest: number): Promise<PullRequestHead>
  /** Recent `labeled` events for the definition's label. Required for issue-label triggers. */
  labelEvents?(definition: BranchCiAutomation): Promise<LabelEventObservation[]>
  /** Whether the issue is still open and still carries the definition's label. */
  issueHasLabel?(definition: BranchCiAutomation, issue: number): Promise<boolean>
  loadProjectThreads(projectId: string): Promise<Thread[]>
  getProjectThread(projectId: string, threadId: string): Promise<Thread | null>
  createProjectThread(projectId: string, thread: Thread): Promise<void>
  releasePreviousRun(projectId: string, threadId: string): Promise<AutomationWorktreeRelease>
  /** See `AutomationServiceDependencies.canReusePreviousRun`. */
  canReusePreviousRun?(projectId: string, threadId: string): Promise<boolean>
  supervisor(): TaskSupervisor
  inboxStore?: EventInboxStore
}

export interface BranchCiAutomationService {
  list(projectId: string): BranchCiAutomation[]
  upsert(projectId: string, input: BranchCiAutomationInput): Promise<BranchCiAutomation>
  remove(projectId: string, id: string): Promise<void>
  testMatch(
    projectId: string,
    input: { branch?: string; trigger?: EventAutomationTriggerInput },
  ): Promise<EventMatchPreview>
  /** Recent deliveries for one automation, newest first: why each started, waits, or was filtered. */
  history(projectId: string, id: string, limit?: number): Promise<EventDeliverySummary[]>
  /**
   * Record that a prepared run could not start (checkout failed, provider rejected it, ...).
   * Only the definition's latest run may report, so a stale or forged thread id changes nothing.
   */
  reportStartFailure(
    projectId: string,
    threadId: string,
    failure: { code: AutomationFailureCode; message: string },
  ): Promise<boolean>
  canStart(
    projectId: string,
    threadId: string,
  ): Promise<{ allowed: boolean; reason?: string; retryable?: boolean }>
  poll(): Promise<void>
  start(sender: (event: AutomationTriggerEvent) => void): void
  sync(): Promise<void>
  stop(): void
}

interface Candidate {
  id: string
  resourceId: string
  resourceRevision: string
  occurredAt: number
  facts: Record<string, string | number | boolean | null>
  payload: string
}

interface Scan {
  candidates: Candidate[]
  /** Observed identities that can never become work; recorded so they are not re-evaluated. */
  ignored: string[]
  /** Pull requests last observed as drafts, when the trigger tracks them. */
  draftPullRequests?: number[]
}

const PR_ID_SHA_LENGTH = 12

function pullRequestDeliveryId(
  pr: Pick<PullRequestObservation, 'number' | 'head'>,
  transition: 'ready-for-review' | 'new-commits',
): string {
  return `pr:${String(pr.number)}:${pr.head.sha.slice(0, PR_ID_SHA_LENGTH)}:${transition === 'ready-for-review' ? 'ready' : 'commits'}`
}

function clip(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function factNumber(record: EventInboxRecord, key: string): number | null {
  const value = record.delivery.facts[key]
  return typeof value === 'number' ? value : null
}

function isoToMillis(value: string, fallback: number): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function createBranchCiAutomationService(
  deps: BranchCiAutomationDependencies,
): BranchCiAutomationService {
  const listeners = new Set<(event: AutomationTriggerEvent) => void>()
  const supervisor = deps.supervisor()
  const inboxStore = deps.inboxStore ?? new FileEventInboxStore()
  const unsupported = (what: string): never => {
    throw new Error(`${what} is not available in this build`)
  }
  const readPullRequests = (definition: BranchCiAutomation): Promise<PullRequestObservation[]> =>
    deps.pullRequests ? deps.pullRequests(definition) : unsupported('Pull request polling')
  const readPullRequest = (
    definition: BranchCiAutomation,
    number: number,
  ): Promise<PullRequestHead> =>
    deps.pullRequestHead ? deps.pullRequestHead(definition, number) : unsupported('Pull requests')
  const readLabels = (definition: BranchCiAutomation): Promise<LabelEventObservation[]> =>
    deps.labelEvents ? deps.labelEvents(definition) : unsupported('Issue label polling')
  const readIssueLabel = (definition: BranchCiAutomation, issue: number): Promise<boolean> =>
    deps.issueHasLabel ? deps.issueHasLabel(definition, issue) : unsupported('Issue polling')

  /** Why a delivery is no longer worth running because its resource moved on, or null while fresh. */
  async function staleReason(
    definition: BranchCiAutomation,
    record: EventInboxRecord,
  ): Promise<string | null> {
    const trigger = definition.trigger
    if (trigger.kind === 'github-ci-failed') {
      const snapshot = await deps.snapshot(definition)
      return snapshot.headSha === record.delivery.resourceRevision
        ? null
        : 'A newer branch head superseded this failed CI run'
    }
    if (trigger.kind === 'github-pr-changed') {
      const number = factNumber(record, 'number')
      if (number === null) return 'The delivery does not name a pull request'
      const head = await readPullRequest(definition, number)
      if (head.state !== 'open') return 'The pull request was closed before the run started'
      if (head.draft) return 'The pull request went back to draft before the run started'
      return head.head.sha === record.delivery.resourceRevision
        ? null
        : 'The pull request received newer commits, which supersede this delivery'
    }
    const number = factNumber(record, 'number')
    if (number === null) return 'The delivery does not name an issue'
    return (await readIssueLabel(definition, number))
      ? null
      : 'The label was removed or the issue was closed before the run started'
  }

  function evaluateDelivery(
    definition: BranchCiAutomation,
    delivery: AutomationDelivery,
  ): { kind: 'match' } | { kind: 'filtered'; reason: string } {
    const trigger = definition.trigger
    if (trigger.kind === 'github-ci-failed') {
      if (delivery.facts['branch'] !== trigger.branch || delivery.facts['conclusion'] !== 'failure')
        return { kind: 'filtered', reason: 'Branch or CI conclusion does not match' }
      const workflow = delivery.facts['workflow']
      if (
        trigger.checks &&
        trigger.checks.length > 0 &&
        !trigger.checks.some(
          (check) => typeof workflow === 'string' && check.toLowerCase() === workflow.toLowerCase(),
        )
      )
        return {
          kind: 'filtered',
          reason: `Check “${clip(String(workflow ?? ''), 80)}” is not one of the selected checks`,
        }
      return { kind: 'match' }
    }
    if (trigger.kind === 'github-pr-changed') {
      return delivery.facts['transition'] === trigger.transition &&
        delivery.facts['base'] === trigger.baseBranch
        ? { kind: 'match' }
        : { kind: 'filtered', reason: 'Pull request transition or base branch does not match' }
    }
    return delivery.facts['label'] === trigger.label
      ? { kind: 'match' }
      : { kind: 'filtered', reason: 'Label does not match' }
  }

  const inbox = new AutomationEventInbox({
    supervisor,
    store: inboxStore,
    adapter: {
      sourceId: ROUTES['github-ci-failed'].sourceId,
      connectionId: CONNECTION_ID,
      eventType: ROUTES['github-ci-failed'].eventType,
      additionalRoutes: [ROUTES['github-pr-changed'], ROUTES['github-issue-labeled']],
      evaluate(eventBinding, delivery): ReturnType<EventInboxAdapter['evaluate']> {
        const definition = definitions().find(
          (candidate) => candidate.id === eventBinding.automationId,
        )
        if (!definition || definition.revision !== eventBinding.definitionRevision)
          return Promise.resolve({ kind: 'filtered', reason: 'Definition changed' })
        return Promise.resolve(evaluateDelivery(definition, delivery))
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
        const stale = await staleReason(definition, record)
        if (stale) return { allowed: false, reason: stale }
        const threads = (await deps.loadProjectThreads(definition.projectId)).filter(
          (thread) => thread.automation?.scheduleId === definition.id,
        )
        if (
          threads.filter((thread) => thread.createdAt >= deps.now() - 86_400_000).length >=
          MAX_RUNS_PER_24_HOURS
        )
          return {
            allowed: false,
            reason: 'Daily automation run limit reached',
            retryable: true,
          }
        if (threads.some((thread) => automationRunBlock(thread) !== null))
          return { allowed: false, reason: 'A run is already pending or active', retryable: true }
        let retained = 0
        let handOverClaimed = false
        for (const thread of threads) {
          if (!thread.worktree || thread.worktree.retiredAt !== undefined) continue
          const released = await deps
            .releasePreviousRun(definition.projectId, thread.id)
            .catch((error: unknown): AutomationWorktreeRelease => {
              console.warn(`[automations] Could not release the worktree of ${thread.id}:`, error)
              return { released: false, reason: 'in-use' }
            })
          if (released.released) continue
          if (
            !handOverClaimed &&
            (await deps
              .canReusePreviousRun?.(definition.projectId, thread.id)
              .catch(() => false)) === true
          ) {
            handOverClaimed = true
            continue
          }
          retained++
        }
        if (retained >= definition.maxLiveWorktrees)
          return { allowed: false, reason: 'Live worktree limit reached', retryable: true }
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
            const facts = record.delivery.facts
            const trigger = definition.trigger
            const { label, source } =
              trigger.kind === 'github-ci-failed'
                ? {
                    label: 'CI run facts',
                    source: {
                      repository: trigger.repository,
                      branch: trigger.branch,
                      ...(trigger.pullRequest !== undefined
                        ? { pullRequest: trigger.pullRequest }
                        : {}),
                      headSha: record.delivery.resourceRevision,
                      workflow: facts['workflow'],
                      runId: facts['runId'],
                      attempt: facts['attempt'],
                      url: facts['url'],
                    },
                  }
                : trigger.kind === 'github-pr-changed'
                  ? {
                      label: 'Pull request facts',
                      source: {
                        repository: trigger.repository,
                        transition: trigger.transition,
                        number: facts['number'],
                        title: facts['title'],
                        author: facts['author'],
                        baseBranch: trigger.baseBranch,
                        headBranch: facts['headRef'],
                        headSha: record.delivery.resourceRevision,
                        url: facts['url'],
                      },
                    }
                  : {
                      label: 'Issue facts',
                      source: {
                        repository: trigger.repository,
                        label: trigger.label,
                        number: facts['number'],
                        title: facts['title'],
                        labeledBy: facts['actor'],
                        url: facts['url'],
                      },
                    }
            const thread: Thread = {
              id: record.runId,
              title: definition.name,
              status: 'idle',
              messages: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              model: definition.model,
              draftPrompt: `${definition.prompt}\n\n${label} (external source data):\n${JSON.stringify(source, null, 2)}`,
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
            await updateDefinitions((definitions) => {
              return definitions.map((item) =>
                item.id === definition.id && item.revision === definition.revision
                  ? {
                      ...withoutProblem(item),
                      lastRunAt: now,
                      lastCreatedThreadId: record.runId,
                    }
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

  function withoutProblem(definition: BranchCiAutomation): BranchCiAutomation {
    const { lastProblem: _dropped, ...rest } = definition
    return rest
  }

  async function setProblem(
    definition: BranchCiAutomation,
    problem: AutomationProblem | null,
  ): Promise<void> {
    try {
      await updateDefinitions((all) =>
        all.map((item) => {
          if (item.id !== definition.id) return item
          // A poll problem never overwrites the more specific failure of a run.
          if (problem === null)
            return item.lastProblem && item.lastProblem.threadId === undefined
              ? withoutProblem(item)
              : item
          if (item.lastProblem?.threadId !== undefined && problem.threadId === undefined)
            return item
          return { ...item, lastProblem: problem }
        }),
      )
    } catch (error) {
      console.error('[automations] Could not record an event automation problem:', error)
    }
  }

  /** Observe the trigger's source and return what it would deliver, without admitting anything. */
  async function scan(definition: BranchCiAutomation): Promise<Scan> {
    const trigger = definition.trigger
    const clock = deps.now()
    if (trigger.kind === 'github-ci-failed') {
      const snapshot = await deps.snapshot(definition)
      const scanResult: Scan = { candidates: [], ignored: [] }
      for (const run of snapshot.runs) {
        if (run.status !== 'completed') continue
        if (trigger.pullRequest === undefined && run.head_branch !== trigger.branch) continue
        const id = deliveryId(run)
        if (definition.seenDeliveries.includes(id)) continue
        if (run.head_sha === snapshot.headSha && failed(run)) {
          scanResult.candidates.push({
            id,
            resourceId: trigger.branch,
            resourceRevision: run.head_sha,
            occurredAt: isoToMillis(run.updated_at, clock),
            facts: {
              branch: trigger.branch,
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
        } else scanResult.ignored.push(id)
      }
      return scanResult
    }
    if (trigger.kind === 'github-pr-changed') {
      const observed = await readPullRequests(definition)
      const wasDraft = new Set(definition.draftPullRequests ?? [])
      const result: Scan = { candidates: [], ignored: [], draftPullRequests: [] }
      for (const pr of observed) {
        if (pr.draft) {
          result.draftPullRequests?.push(pr.number)
          continue
        }
        if (trigger.transition === 'ready-for-review' && !wasDraft.has(pr.number)) continue
        const id = pullRequestDeliveryId(pr, trigger.transition)
        if (definition.seenDeliveries.includes(id)) continue
        result.candidates.push({
          id,
          resourceId: `pr-${String(pr.number)}`,
          resourceRevision: pr.head.sha,
          occurredAt: isoToMillis(pr.updated_at, clock),
          facts: {
            number: pr.number,
            title: clip(pr.title, 512),
            author: pr.author,
            base: trigger.baseBranch,
            headRef: pr.head.ref,
            transition: trigger.transition,
            url: pr.html_url,
          },
          payload: JSON.stringify({ number: pr.number, headSha: pr.head.sha }),
        })
      }
      return result
    }
    const events = await readLabels(definition)
    const result: Scan = { candidates: [], ignored: [] }
    for (const event of events) {
      const id = `evt:${String(event.id)}`
      if (definition.seenDeliveries.includes(id)) continue
      if (event.label !== trigger.label || event.issue.state !== 'open') {
        result.ignored.push(id)
        continue
      }
      result.candidates.push({
        id,
        resourceId: `issue-${String(event.issue.number)}`,
        resourceRevision: String(event.id),
        occurredAt: isoToMillis(event.created_at, clock),
        facts: {
          number: event.issue.number,
          title: clip(event.issue.title, 512),
          actor: event.actor,
          label: event.label,
          url: event.issue.html_url,
        },
        payload: JSON.stringify({ eventId: event.id, issue: event.issue.number }),
      })
    }
    return result
  }

  async function markSeen(
    definition: BranchCiAutomation,
    ids: readonly string[],
    draftPullRequests: number[] | undefined,
  ): Promise<void> {
    await updateDefinitions((all) => {
      return all.map((item) => {
        if (item.id !== definition.id || item.revision !== definition.revision) return item
        const seen = [...new Set([...item.seenDeliveries, ...ids])].slice(-100)
        return {
          ...item,
          seenDeliveries: seen,
          ...(draftPullRequests !== undefined
            ? { draftPullRequests: draftPullRequests.slice(-100) }
            : {}),
        }
      })
    })
  }

  async function pollDefinition(definition: BranchCiAutomation): Promise<void> {
    const result = await scan(definition)
    const settled: string[] = [...result.ignored]
    // A ready-for-review transition is only recognisable while the PR is still remembered as a
    // draft, so a delivery held back by a limit keeps its PR in that set until it is admitted.
    const pendingReady = new Set<number>()
    for (const candidate of result.candidates) {
      if (definition.trigger.kind === 'github-ci-failed') {
        const prior = (await deps.loadProjectThreads(definition.projectId)).filter(
          (thread) => thread.automation?.scheduleId === definition.id,
        )
        if (prior.some((thread) => automationRunBlock(thread) !== null)) continue
      }
      await inbox.admit(definition.id, definition.revision, {
        sourceId: ROUTES[definition.trigger.kind].sourceId,
        connectionId: CONNECTION_ID,
        deliveryId: candidate.id,
        eventType: ROUTES[definition.trigger.kind].eventType,
        eventVersion: 1,
        projectId: definition.projectId,
        repositoryId: definition.trigger.repository,
        resourceId: candidate.resourceId,
        resourceRevision: candidate.resourceRevision,
        occurredAt: candidate.occurredAt,
        facts: candidate.facts,
        payload: candidate.payload,
      })
      await inbox.reconcile(definition.projectId)
      // A delivery held back only by a capacity limit stays pending. Marking it
      // seen would drop a real event the moment the limit clears; leave it
      // for the next poll, which re-admits it idempotently and checks again.
      const waiting = (await inboxStore.list(definition.projectId)).some(
        (record) =>
          record.binding.automationId === definition.id &&
          record.delivery.deliveryId === candidate.id &&
          record.state === 'admitted',
      )
      if (waiting) {
        const number = candidate.facts['number']
        if (typeof number === 'number') pendingReady.add(number)
        continue
      }
      settled.push(candidate.id)
    }
    const drafts =
      result.draftPullRequests === undefined
        ? undefined
        : [...new Set([...result.draftPullRequests, ...pendingReady])]
    if (settled.length > 0 || drafts !== undefined) await markSeen(definition, settled, drafts)
  }

  async function poll(): Promise<void> {
    if (polling || !deps.isPluginEnabled()) return
    polling = true
    try {
      const active = definitions().filter((definition) => definition.enabled)
      for (const definition of active) {
        try {
          await pollDefinition(definition)
          if (definition.lastProblem && definition.lastProblem.threadId === undefined)
            await setProblem(definition, null)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[automations] Event polling failed for “${definition.name}”:`, error)
          await setProblem(definition, {
            at: deps.now(),
            kind: 'failed',
            message: clip(`Could not read GitHub: ${message}`, 500),
            code: classifyAutomationFailureMessage(message),
          })
        }
      }
    } finally {
      polling = false
    }
  }

  async function resolveTrigger(
    projectId: string,
    input: BranchCiAutomationInput,
    existing: BranchCiAutomation | undefined,
  ): Promise<EventAutomationTrigger> {
    const requested: EventAutomationTriggerInput = input.trigger ?? {
      kind: 'github-ci-failed',
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    }
    const reuse = (repository: string): boolean =>
      !input.enabled && existing !== undefined && existing.trigger.repository === repository
    const repositoryFor = async (): Promise<string> =>
      !input.enabled && existing
        ? existing.trigger.repository
        : deps.repositoryForProject(projectId)
    if (requested.kind === 'github-pr-changed') {
      return {
        kind: 'github-pr-changed',
        repository: await repositoryFor(),
        baseBranch: branchSchema.parse(requested.baseBranch),
        transition: requested.transition,
      }
    }
    if (requested.kind === 'github-issue-labeled') {
      return {
        kind: 'github-issue-labeled',
        repository: await repositoryFor(),
        label: z.string().regex(LABEL_PATTERN, 'Choose a valid label name').parse(requested.label),
      }
    }
    const checks = [
      ...new Map(
        (requested.checks ?? [])
          .map((check) => check.trim())
          .filter((check) => check.length > 0)
          .map((check) => [check.toLowerCase(), check] as const),
      ).values(),
    ]
    if (checks.length > MAX_CHECK_FILTERS)
      throw new Error(`Select at most ${String(MAX_CHECK_FILTERS)} checks`)
    const common = checks.length > 0 ? { checks } : {}
    if (requested.pullRequest !== undefined) {
      const repository = await repositoryFor()
      const head = await readPullRequest(
        {
          ...(existing ?? placeholderDefinition(projectId, input)),
          trigger: { kind: 'github-ci-failed', repository, branch: 'pending' },
        },
        requested.pullRequest,
      )
      if (head.state !== 'open')
        throw new Error(`Pull request #${String(requested.pullRequest)} is not open`)
      return {
        kind: 'github-ci-failed',
        repository,
        branch: branchSchema.parse(head.head.ref),
        pullRequest: requested.pullRequest,
        ...common,
      }
    }
    const branch = branchSchema.parse(requested.branch ?? '')
    const repository =
      existing?.trigger.kind === 'github-ci-failed' &&
      existing.trigger.branch === branch &&
      reuse(existing.trigger.repository)
        ? existing.trigger.repository
        : await deps.repositoryForProject(projectId)
    return { kind: 'github-ci-failed', repository, branch, ...common }
  }

  function placeholderDefinition(
    projectId: string,
    input: Pick<
      BranchCiAutomationInput,
      'name' | 'prompt' | 'model' | 'enabled' | 'maxLiveWorktrees'
    >,
  ): BranchCiAutomation {
    const now = deps.now()
    return {
      v: 1,
      id: randomUUID(),
      projectId,
      name: input.name,
      trigger: {
        kind: 'github-ci-failed',
        repository: 'github.com/preview/preview',
        branch: 'main',
      },
      prompt: input.prompt,
      model: input.model,
      enabled: input.enabled,
      maxLiveWorktrees: input.maxLiveWorktrees ?? 1,
      revision: randomUUID(),
      createdAt: now,
      updatedAt: now,
      seenDeliveries: [],
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
          reason: 'The automation was paused or changed before this task started.',
        }
      if (record.state !== 'prepared' && record.state !== 'queued')
        return { allowed: false, reason: 'The delivery is no longer eligible.' }
      try {
        const stale = await staleReason(definition, record)
        if (stale) return { allowed: false, reason: `${stale}.` }
      } catch {
        return {
          allowed: false,
          reason:
            'Could not verify the source is still current. This task will retry when the project is opened again.',
          retryable: true,
        }
      }
      return { allowed: true }
    },
    list(projectId: string): BranchCiAutomation[] {
      return definitions().filter((item) => item.projectId === projectId)
    },
    async history(projectId, id, limit = 25): Promise<EventDeliverySummary[]> {
      const records = (await inboxStore.list(projectId))
        .filter((record) => record.binding.automationId === id)
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, Math.max(1, Math.min(limit, 100)))
      return records.map((record): EventDeliverySummary => {
        const facts = record.delivery.facts
        const number = factNumber(record, 'number')
        const summary =
          record.binding.eventType === ROUTES['github-ci-failed'].eventType
            ? `${clip(String(facts['workflow'] ?? 'CI'), 120)} failed on ${clip(String(facts['branch'] ?? ''), 80)}`
            : `#${String(number ?? '?')} ${clip(String(facts['title'] ?? ''), 160)}`
        const url = facts['url']
        const base = {
          key: record.key,
          deliveryId: record.delivery.deliveryId,
          summary,
          receivedAt: record.receivedAt,
          ...(typeof url === 'string' ? { url } : {}),
        }
        switch (record.state) {
          case 'prepared':
          case 'queued':
          case 'claimed':
            return {
              ...base,
              outcome: 'started',
              ...(record.runId ? { threadId: record.runId } : {}),
            }
          case 'admitted':
            return {
              ...base,
              outcome: 'waiting',
              reason: 'Waiting for a free run slot or checkout; Copse rechecks every minute.',
            }
          case 'filtered':
            return { ...base, outcome: 'filtered', reason: record.reason ?? 'Filtered out' }
          case 'fenced':
            return { ...base, outcome: 'held', reason: record.reason ?? 'Held' }
        }
      })
    },
    async reportStartFailure(projectId, threadId, failure): Promise<boolean> {
      const definition = definitions().find(
        (item) => item.projectId === projectId && item.lastCreatedThreadId === threadId,
      )
      if (!definition) return false
      await setProblem(definition, {
        at: deps.now(),
        kind: 'failed',
        message: clip(failure.message, 500),
        code: failure.code,
        threadId,
      })
      return true
    },
    async upsert(projectId: string, input: BranchCiAutomationInput): Promise<BranchCiAutomation> {
      const existing = input.id
        ? definitions().find((item) => item.id === input.id && item.projectId === projectId)
        : undefined
      if (input.id && !existing) throw new Error('CI automation not found in this project')
      const trigger = await resolveTrigger(projectId, input, existing)
      const now = deps.now()
      const changedSource =
        !existing ||
        JSON.stringify(existing.trigger) !== JSON.stringify(trigger) ||
        (!existing.enabled && input.enabled)
      const draft: BranchCiAutomation = {
        ...(existing ?? placeholderDefinition(projectId, input)),
        trigger,
        seenDeliveries: [],
      }
      // Baseline: everything that already exists is history, not an event.
      let baseline: { seen: string[]; drafts?: number[] } | null = null
      if (changedSource) {
        if (trigger.kind === 'github-ci-failed') {
          const snapshot = await deps.snapshot(draft)
          baseline = {
            seen: snapshot.runs
              .filter((run) => run.status === 'completed')
              .map(deliveryId)
              .slice(-100),
          }
        } else if (trigger.kind === 'github-pr-changed') {
          const observed = await readPullRequests(draft)
          baseline = {
            seen:
              trigger.transition === 'new-commits'
                ? observed
                    .filter((pr) => !pr.draft)
                    .map((pr) => pullRequestDeliveryId(pr, 'new-commits'))
                    .slice(-100)
                : [],
            drafts: observed.filter((pr) => pr.draft).map((pr) => pr.number),
          }
        } else {
          baseline = {
            seen: (await readLabels(draft)).map((event) => `evt:${String(event.id)}`).slice(-100),
          }
        }
      }
      const definition: BranchCiAutomation = {
        v: 1,
        id: existing?.id ?? randomUUID(),
        projectId,
        name: input.name.trim(),
        trigger,
        prompt: input.prompt.trim(),
        model: input.model.trim(),
        enabled: input.enabled,
        maxLiveWorktrees: input.maxLiveWorktrees ?? existing?.maxLiveWorktrees ?? 1,
        revision: randomUUID(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        seenDeliveries: baseline ? baseline.seen : (existing?.seenDeliveries ?? []),
        ...(baseline
          ? baseline.drafts !== undefined
            ? { draftPullRequests: baseline.drafts.slice(-100) }
            : {}
          : existing?.draftPullRequests !== undefined
            ? { draftPullRequests: existing.draftPullRequests }
            : {}),
        ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
        ...(existing?.lastCreatedThreadId
          ? { lastCreatedThreadId: existing.lastCreatedThreadId }
          : {}),
      }
      await runSerialized(definitionKey(projectId, definition.id), async () => {
        const latest = definitions().find((item) => item.id === definition.id)
        if (latest?.revision !== existing?.revision)
          throw new Error('CI automation changed while editing; reload it and try again')
        await updateDefinitions((definitions) => {
          return [...definitions.filter((item) => item.id !== definition.id), definition]
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
        await updateDefinitions((definitions) => {
          return definitions.filter((item) => !(item.id === id && item.projectId === projectId))
        })
      })
      await inbox.fence(projectId, id, 'Automation deleted')
      await service.sync()
    },
    async testMatch(projectId, input): Promise<EventMatchPreview> {
      const requested: EventAutomationTriggerInput = input.trigger ?? {
        kind: 'github-ci-failed',
        branch: input.branch ?? '',
      }
      const probe: BranchCiAutomationInput = {
        name: 'Preview',
        prompt: 'Preview',
        model: 'preview',
        enabled: false,
        trigger: requested,
      }
      const trigger = await resolveTrigger(projectId, probe, undefined)
      const draft: BranchCiAutomation = { ...placeholderDefinition(projectId, probe), trigger }
      if (trigger.kind === 'github-ci-failed') {
        const snapshot = await deps.snapshot(draft)
        const matching = snapshot.runs.filter(
          (run) =>
            run.head_sha === snapshot.headSha &&
            failed(run) &&
            (!trigger.checks ||
              trigger.checks.length === 0 ||
              trigger.checks.some((check) => check.toLowerCase() === run.name.toLowerCase())),
        )
        return {
          repository: trigger.repository,
          branch: trigger.branch,
          latestFailure: matching[0]?.html_url ?? null,
          recent: matching.slice(0, 5).map((run) => clip(`${run.name} · ${run.html_url}`, 200)),
        }
      }
      if (trigger.kind === 'github-pr-changed') {
        const observed = await readPullRequests(draft)
        const recent = observed
          .filter((pr) => (trigger.transition === 'ready-for-review' ? !pr.draft : !pr.draft))
          .slice(0, 5)
          .map((pr) => `#${String(pr.number)} ${clip(pr.title, 120)}`)
        return {
          repository: trigger.repository,
          branch: trigger.baseBranch,
          latestFailure: null,
          recent,
        }
      }
      const events = await readLabels(draft)
      return {
        repository: trigger.repository,
        branch: '',
        latestFailure: null,
        recent: events
          .slice(0, 5)
          .map((event) => `#${String(event.issue.number)} ${clip(event.issue.title, 120)}`),
      }
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
        console.error('[automations] Event recovery failed:', error)
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

async function projectGithub<T>(
  definition: BranchCiAutomation,
  read: (root: string) => Promise<T>,
): Promise<T> {
  const root = getProjectRoot(definition.projectId)
  if (!root) throw new Error('Project is unavailable')
  const repository = await repositoryForProject(definition.projectId)
  if (repository !== definition.trigger.repository) throw new Error('Project repository changed')
  return read(root)
}

let singleton: BranchCiAutomationService | null = null
export function getBranchCiAutomationService(): BranchCiAutomationService {
  singleton ??= createBranchCiAutomationService({
    now: Date.now,
    isPluginEnabled: () => getPluginService().registry.isEnabled(AUTOMATIONS_PLUGIN_ID),
    repositoryForProject,
    snapshot: snapshotFor,
    pullRequests: (definition) =>
      projectGithub(definition, (root) =>
        definition.trigger.kind === 'github-pr-changed'
          ? readOpenPullRequests(root, definition.trigger.repository, definition.trigger.baseBranch)
          : Promise.resolve([]),
      ),
    pullRequestHead: (definition, pullRequest) =>
      projectGithub(definition, (root) =>
        readPullRequestHead(root, definition.trigger.repository, pullRequest),
      ),
    labelEvents: (definition) =>
      projectGithub(definition, (root) =>
        definition.trigger.kind === 'github-issue-labeled'
          ? readLabelEvents(root, definition.trigger.repository, definition.trigger.label)
          : Promise.resolve([]),
      ),
    issueHasLabel: (definition, issue) =>
      projectGithub(definition, (root) =>
        definition.trigger.kind === 'github-issue-labeled'
          ? readIssueHasLabel(root, definition.trigger.repository, issue, definition.trigger.label)
          : Promise.resolve(false),
      ),
    loadProjectThreads,
    getProjectThread,
    createProjectThread: createThread,
    releasePreviousRun: releaseCompletedAutomationWorktree,
    canReusePreviousRun: (projectId, threadId) =>
      getAutomationWorktreeReuse().canReusePreviousRun(projectId, threadId),
    supervisor: getTaskSupervisor,
  })
  return singleton
}
