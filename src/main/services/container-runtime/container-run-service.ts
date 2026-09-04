import { randomBytes } from 'node:crypto'
import type {
  ContainerRunPhase,
  ContainerRunProgress,
  ContainerRunRequest,
} from '@shared/types/container-run.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { storageGet } from '../storage/storage.ts'
import { getProjectRoot } from '../workspace.ts'
import { recordDecision } from '../security/decision-log-store.ts'
import { resolveContainerProvider } from '../providers/container-provider.ts'
import {
  buildWorkerImage,
  newRuntimeId,
  runThreadInContainer,
  WORKER_IMAGE,
  workerImageExists,
  type ThreadContainerRequest,
} from './thread-container.ts'

/**
 * One unattended container run per thread, driven from the UI
 * (`docs/plans/thread-in-container.md`).
 *
 * The service owns what the renderer must never hold: the workspace path, the
 * resolved provider and its key, and the run itself. It publishes a bounded
 * snapshot (`ContainerRunProgress`) on every change so the renderer can show a
 * phase, a log tail and, at the end, the review record. Runs are session-only:
 * the record on disk under the profile is the durable artefact, this map is
 * just what the window is looking at.
 */

const LOG_TAIL = 60

interface RunDependencies {
  run: typeof runThreadInContainer
  ensureImage: () => Promise<void>
}

const productionDependencies: RunDependencies = {
  run: runThreadInContainer,
  ensureImage: async (): Promise<void> => {
    if (!(await workerImageExists(WORKER_IMAGE))) await buildWorkerImage({ image: WORKER_IMAGE })
  },
}

function projectIsRemote(projectId: string): boolean {
  const projects = storageGet('projects')
  if (!Array.isArray(projects)) return false
  return projects.some(
    (project) =>
      isRecord(project) && project['id'] === projectId && typeof project['sshHost'] === 'string',
  )
}

export class ContainerRunService {
  private readonly runs = new Map<string, ContainerRunProgress>()
  private readonly listeners = new Set<(progress: ContainerRunProgress) => void>()
  private readonly deps: RunDependencies

  constructor(deps: RunDependencies = productionDependencies) {
    this.deps = deps
  }

  get(threadId: string): ContainerRunProgress | null {
    const progress = this.runs.get(threadId)
    return progress ? snapshot(progress) : null
  }

  onChanged(listener: (progress: ContainerRunProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  isActive(threadId: string): boolean {
    const phase = this.runs.get(threadId)?.phase
    return phase !== undefined && phase !== 'finished' && phase !== 'failed'
  }

  /**
   * Start a run and return its first snapshot. The run continues in the
   * background; progress arrives through {@link onChanged}. Throws for a thread
   * that already has a live run, a remote (SSH) project, and a model the
   * container cannot reach — all decided before Docker is touched.
   */
  start(request: ContainerRunRequest): ContainerRunProgress {
    if (this.isActive(request.threadId)) {
      throw new Error('This thread already has a container run in progress')
    }
    const workspace = getProjectRoot(request.projectId)
    if (!workspace) throw new Error('The project has no local checkout to carry into a container')
    if (projectIsRemote(request.projectId)) {
      throw new Error('Container runs need a local checkout; this project lives on an SSH host')
    }
    const prompt = request.prompt.trim()
    if (!prompt) throw new Error('The run needs a prompt')
    const model = request.model
    const plan = resolveContainerProvider(model)
    const egressAllowlist = [...new Set([plan.egress, ...(request.extraEgress ?? [])])]

    const progress: ContainerRunProgress = {
      threadId: request.threadId,
      runtimeId: null,
      phase: 'preparing',
      startedAt: Date.now(),
      finishedAt: null,
      model,
      egressAllowlist,
      log: [],
      record: null,
      error: null,
    }
    this.runs.set(request.threadId, progress)
    // The arming itself is a user decision worth a line in the durable log,
    // like enabling Guarded YOLO, so the thread's record shows who let a run
    // act without asking and under which budget.
    recordDecision({
      kind: 'mode',
      actor: 'user',
      verdict: 'approved',
      subject: 'unattended container run',
      scope: 'container',
      reasons: [
        `model ${model}`,
        `egress ${egressAllowlist.join(', ')}`,
        `wall-clock ${String(Math.round(request.budgets.wallClockMs / 60_000))} min`,
        `tokens ${String(request.budgets.tokenCeiling)}`,
      ],
      cause: 'mode-arming',
      threadId: request.threadId,
      projectId: request.projectId,
    })
    this.emit(progress)
    // A copy taken before the drive starts: the run mutates its own object as
    // it advances, and the caller wants the state it asked for.
    const first = snapshot(progress)
    void this.drive(request, plan, workspace, progress)
    return first
  }

  private async drive(
    request: ContainerRunRequest,
    plan: ReturnType<typeof resolveContainerProvider>,
    workspace: string,
    progress: ContainerRunProgress,
  ): Promise<void> {
    const runtimeId = newRuntimeId()
    // The key travels as an environment variable the runner names on the
    // `docker run` command line, so neither the value nor a host variable name
    // appears in argv or in the run's files; it is removed once the container
    // is up.
    const keyEnv = `COPSE_CONTAINER_RUN_KEY_${randomBytes(4).toString('hex').toUpperCase()}`
    const apiKey = plan.apiKey
    const log = (line: string): void => {
      this.update(progress, { log: [...progress.log, line].slice(-LOG_TAIL) })
      this.update(progress, { phase: phaseFromLog(line, progress.phase) })
    }
    try {
      this.update(progress, { phase: 'building-image', runtimeId })
      await this.deps.ensureImage()
      this.update(progress, { phase: 'starting' })
      if (apiKey) process.env[keyEnv] = apiKey
      const runRequest: ThreadContainerRequest = {
        workspace,
        prompt: request.prompt.trim(),
        model: plan.model,
        ...(plan.mode === 'openai-compatible'
          ? { providerUrl: plan.url }
          : { productProvider: { apiKeySlug: plan.apiKeySlug } }),
        ...(apiKey ? { apiKeyEnv: keyEnv } : {}),
        budgets: request.budgets,
        egressAllowlist: progress.egressAllowlist,
        image: WORKER_IMAGE,
      }
      const record = await this.deps.run(runRequest, {
        runtimeId,
        onLog: log,
        onStarted: () => {
          // The container has the key now; the host process no longer needs it.
          process.env[keyEnv] = ''
        },
      })
      this.update(progress, {
        phase: record.result && record.result.stopReason !== 'error' ? 'finished' : 'failed',
        record,
        finishedAt: Date.now(),
        error: record.result?.error ?? (record.result ? null : 'The guest wrote no result'),
      })
    } catch (error) {
      this.update(progress, {
        phase: 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      process.env[keyEnv] = ''
    }
  }

  private update(progress: ContainerRunProgress, patch: Partial<ContainerRunProgress>): void {
    const next = { ...progress, ...patch }
    this.runs.set(progress.threadId, next)
    Object.assign(progress, next)
    this.emit(next)
  }

  private emit(progress: ContainerRunProgress): void {
    for (const listener of this.listeners) listener(snapshot(progress))
  }

  /** Test seam: forget every run. */
  clearForTests(): void {
    this.runs.clear()
  }
}

function snapshot(progress: ContainerRunProgress): ContainerRunProgress {
  return { ...progress, log: [...progress.log] }
}

/** Phase transitions the runner's log lines imply, without a second event channel. */
export function phaseFromLog(line: string, current: ContainerRunPhase): ContainerRunPhase {
  if (current === 'finished' || current === 'failed') return current
  if (line.includes('[thread-container] starting ')) return 'running'
  if (line.includes('wall-clock budget reached') || line.includes('[worker] done:')) {
    return 'collecting'
  }
  return current
}

let service: ContainerRunService | null = null

export function getContainerRunService(): ContainerRunService {
  service ??= new ContainerRunService()
  return service
}
