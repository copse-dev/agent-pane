import { randomBytes } from 'node:crypto'
import type {
  ContainerRunPhase,
  ContainerRunProgress,
  ContainerRunRequest,
} from '@shared/types/container-run.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { execFileSync } from 'node:child_process'
import { storageGet } from '../storage/storage.ts'
import {
  resolveThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'
import { recordDecision } from '../security/decision-log-store.ts'
import { resolveContainerProvider } from '../providers/container-provider.ts'
import { DEPENDENCY_INSTALL_ORIGINS } from './guest-install.ts'
import {
  adoptCarryOut,
  buildWorkerImage,
  loadCarryOutForAdoption,
  newRuntimeId,
  runThreadInContainer,
  sweepOrphanedRuntimes,
  teardownRuntime,
  type OrphanSweep,
  type CarryOutAdoption,
  WORKER_IMAGE,
  workerBuildFingerprint,
  workerImageFingerprint,
  type ThreadContainerRequest,
} from './thread-container.ts'
import type { ThreadContainerRecord } from '@shared/types/container-run.ts'

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
  /** Force-remove a live run's container; the runner's wait then settles. */
  stop: typeof teardownRuntime
  /**
   * The checkout this thread actually works in. Injected like the supervisor's
   * so a test can describe a worktree without building one.
   */
  resolveContext: (projectId: string, threadId: string) => Promise<ThreadExecutionContext>
  /** Remove what earlier app sessions left behind; see {@link sweepOrphanedRuntimes}. */
  sweep: typeof sweepOrphanedRuntimes
  /** Apply a run's commits to a checkout; see {@link adoptCarryOut}. */
  adopt: typeof adoptCarryOut
  /** A finished run's ref and base from its record on disk, for a run this session did not start. */
  loadCarryOut: typeof loadCarryOutForAdoption
}

const productionDependencies: RunDependencies = {
  run: runThreadInContainer,
  stop: teardownRuntime,
  sweep: sweepOrphanedRuntimes,
  adopt: adoptCarryOut,
  loadCarryOut: loadCarryOutForAdoption,
  // Rebuild whenever the shipped worker differs from the one the existing
  // image was built from. Reusing on tag alone would keep an app upgrade
  // running the previous guest — and its previous security behaviour.
  ensureImage: async (): Promise<void> => {
    const wanted = workerBuildFingerprint()
    if ((await workerImageFingerprint(WORKER_IMAGE)) === wanted) return
    await buildWorkerImage({ image: WORKER_IMAGE })
  },
  resolveContext: resolveThreadExecutionContext,
}

/**
 * Refuse a root git would not snapshot, with a readable reason. Without this
 * the failure surfaces mid-run as a raw `git rev-parse` error from carry-in,
 * after the image build and the container start.
 */
function assertGitCheckout(root: string, describe: string): void {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' })
  } catch {
    throw new Error(
      `${describe} (${root}) is not a git checkout with a commit; a container run carries the work in as a git snapshot`,
    )
  }
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
  /** Threads whose live run the user asked to stop, until the run settles. */
  private readonly stopRequested = new Set<string>()
  private readonly deps: RunDependencies

  constructor(deps: RunDependencies = productionDependencies) {
    this.deps = deps
  }

  /**
   * Called once at app start. Runs are session-only, so anything managed
   * that this process did not start is an orphan: a container and a volume
   * of several gigabytes from a run the previous session quit on. Docker
   * being absent is not an error here; there is nothing to sweep.
   */
  async sweepOrphans(): Promise<OrphanSweep | null> {
    try {
      const sweep = await this.deps.sweep()
      if (sweep.removed.length > 0 || sweep.failed.length > 0) {
        console.log(
          `[container-run] swept ${String(sweep.removed.length)} orphaned run(s)` +
            (sweep.failed.length > 0 ? `; could not remove ${sweep.failed.join(', ')}` : ''),
        )
      }
      return sweep
    } catch {
      return null
    }
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
   * Stop a live run. Closing the dialog never does this — the run belongs to
   * the main process, not the window — so it is its own action. A container
   * that is up is force-removed, which settles the runner's wait; a run that
   * has not reached `docker run` yet is refused at that point instead. The
   * outcome is reported as a stop by the user, not as a guest failure.
   */
  async stop(threadId: string): Promise<ContainerRunProgress | null> {
    const progress = this.runs.get(threadId)
    if (!progress || !this.isActive(threadId)) return progress ? snapshot(progress) : null
    this.stopRequested.add(threadId)
    this.update(progress, {
      log: [...progress.log, '[thread-container] stop requested by the user'].slice(-LOG_TAIL),
    })
    if (progress.runtimeId !== null && progress.phase !== 'building-image') {
      const outcome = await this.deps.stop(progress.runtimeId)
      if (outcome === 'failed') {
        this.update(progress, {
          log: [...progress.log, '[thread-container] the container could not be removed'].slice(
            -LOG_TAIL,
          ),
        })
      }
    }
    return snapshot(progress)
  }

  /**
   * Follow up on a finished run in the thread's own checkout (decision A13):
   * cherry-pick the guest's commits onto the checkout's HEAD. The run is
   * looked up in memory first and on disk after — the record outlives the
   * session, and so should the follow-up — and it must belong to the thread
   * asking, so one thread cannot pull another's run into its checkout.
   */
  async adopt(projectId: string, threadId: string, runtimeId: string): Promise<CarryOutAdoption> {
    if (this.isActive(threadId)) {
      throw new Error('This thread has a container run in progress; wait for it to finish')
    }
    const live = this.runs.get(threadId)
    const fromMemory =
      live?.record && live.record.runtimeId === runtimeId && live.record.carryOut.ref !== null
        ? { threadId, ref: live.record.carryOut.ref, base: live.record.carryIn.sha }
        : null
    const source = fromMemory ?? this.deps.loadCarryOut(runtimeId)
    if (source === null) {
      throw new Error('This run fetched no commits, or its record is gone')
    }
    if (source.threadId !== threadId) {
      throw new Error('This run belongs to another thread')
    }
    const checkout = await this.deps.resolveContext(projectId, threadId)
    const adoption = this.deps.adopt(checkout.root, source.ref, source.base)
    recordDecision({
      kind: 'mode',
      actor: 'user',
      verdict: 'approved',
      subject: 'container run commits applied to the checkout',
      scope: 'container',
      reasons: [
        `ref ${source.ref}`,
        `applied ${String(adoption.applied.length)}`,
        `already present ${String(adoption.alreadyApplied)}`,
      ],
      cause: 'mode-arming',
      threadId,
      projectId,
    })
    if (live) {
      this.update(live, {
        log: [
          ...live.log,
          `[thread-container] ${String(adoption.applied.length)} commit(s) from ${source.ref} applied to the checkout`,
        ].slice(-LOG_TAIL),
      })
    }
    return adoption
  }

  /**
   * Start a run and return its first snapshot. The run continues in the
   * background; progress arrives through {@link onChanged}. Throws for a thread
   * that already has a live run, a remote (SSH) project, and a model the
   * container cannot reach — all decided before Docker is touched.
   */
  async start(request: ContainerRunRequest): Promise<ContainerRunProgress> {
    if (this.isActive(request.threadId)) {
      throw new Error('This thread already has a container run in progress')
    }
    if (projectIsRemote(request.projectId)) {
      throw new Error('Container runs need a local checkout; this project lives on an SSH host')
    }
    const prompt = request.prompt.trim()
    if (!prompt) throw new Error('The run needs a prompt')
    const model = request.model
    const plan = resolveContainerProvider(model, { useAgentLogin: request.useAgentLogin === true })
    const credential: ContainerRunProgress['credential'] =
      plan.mode === 'acp' && plan.harness.login ? 'login' : plan.apiKey ? 'key' : 'none'
    // The registry and GitHub are reachable when the run installs (A9, A11);
    // the guest's shell commands are off the network either way.
    const install = request.installDependencies === true
    const egressAllowlist = [
      ...new Set([
        ...plan.egress,
        ...(install ? DEPENDENCY_INSTALL_ORIGINS : []),
        ...(request.extraEgress ?? []),
      ]),
    ]

    const progress: ContainerRunProgress = {
      threadId: request.threadId,
      runtimeId: null,
      phase: 'preparing',
      startedAt: Date.now(),
      finishedAt: null,
      prompt: request.prompt.trim(),
      model,
      egressAllowlist,
      credential,
      log: [],
      warnings: [],
      checkout: null,
      record: null,
      error: null,
    }
    // Claim the thread's slot before the first await, so two clicks cannot both
    // pass the live-run check and start two containers on one checkout.
    this.runs.set(request.threadId, progress)

    let checkout: ThreadExecutionContext
    try {
      // The thread — not the project — owns the checkout the run must carry in:
      // a thread in an isolated worktree has its own branch and its own
      // uncommitted edits, and snapshotting the project root would silently run
      // the wrong tree. The resolver validates the worktree and throws rather
      // than falling back, which is exactly the behaviour wanted here.
      checkout = await this.deps.resolveContext(request.projectId, request.threadId)
      assertGitCheckout(
        checkout.root,
        checkout.checkoutMode === 'worktree' ? "The thread's worktree" : 'The project checkout',
      )
    } catch (error) {
      this.runs.delete(request.threadId)
      throw error
    }
    this.update(progress, {
      checkout: {
        root: checkout.root,
        mode: checkout.checkoutMode,
        branch: checkout.branch,
      },
    })

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
        `checkout ${checkout.checkoutMode}${checkout.branch ? ` (${checkout.branch})` : ''}`,
        `egress ${egressAllowlist.join(', ')}`,
        credential === 'login'
          ? 'credential: your desktop sign-in, copied in for the run'
          : credential === 'key'
            ? 'credential: one API key, scoped to the run'
            : 'credential: none',
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
    void this.drive(request, plan, checkout.root, progress)
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
      if (this.stopRequested.has(request.threadId)) {
        throw new Error('Stopped by you before the container started')
      }
      this.update(progress, { phase: 'starting' })
      if (apiKey) process.env[keyEnv] = apiKey
      const runRequest: ThreadContainerRequest = {
        workspace,
        prompt: request.prompt.trim(),
        model: plan.model,
        ...(plan.mode === 'openai-compatible'
          ? { providerUrl: plan.url }
          : plan.mode === 'product'
            ? { productProvider: { apiKeySlug: plan.apiKeySlug } }
            : { acp: plan.harness }),
        ...(apiKey ? { apiKeyEnv: keyEnv } : {}),
        budgets: request.budgets,
        ...(request.installDependencies === true ? { installDependencies: true } : {}),
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
      const outcome = judgeRun(record)
      // A run the user stopped is not a guest failure; say what happened.
      const stopped = this.stopRequested.has(request.threadId)
      this.update(progress, {
        phase: outcome.failure === null && !stopped ? 'finished' : 'failed',
        record,
        finishedAt: Date.now(),
        error: stopped ? 'Stopped by you before the guest finished' : outcome.failure,
        warnings: outcome.warnings,
      })
    } catch (error) {
      this.update(progress, {
        phase: 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      process.env[keyEnv] = ''
      this.stopRequested.delete(request.threadId)
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

/**
 * Whether a finished run may be called finished, and what to say about it.
 *
 * A run is only clean when the guest wrote a result it did not itself call an
 * error, the commits it produced were actually fetched, and the container was
 * stopped and reaped. Anything else is a failure with a reason: the record can
 * hold three commits and still be a run whose work never reached a ref the user
 * can review, or one that left a container running. Cleanup problems that do
 * not affect the work are reported as warnings alongside.
 */
export function judgeRun(record: ThreadContainerRecord): {
  failure: string | null
  warnings: string[]
} {
  const warnings: string[] = []
  if (record.cleanupError !== null) warnings.push(record.cleanupError)
  if (record.teardown === 'failed') {
    warnings.push('The container could not be removed; remove it by hand before the next run.')
  }
  if (record.secretCanary.present) {
    warnings.push(`Secret canary leaked into the run: ${record.secretCanary.detail}`)
  }
  // A destination the guest asked for and did not get is the likeliest reason
  // an agent "completed" having done nothing; say so where the user looks.
  const refused = record.egress.filter((entry) => entry.event === 'refused')
  if (refused.length > 0) {
    const origins = [...new Set(refused.map((entry) => entry.origin))]
    warnings.push(
      `${String(refused.length)} connection${refused.length === 1 ? '' : 's'} refused by the egress allowlist: ${origins.join(', ')}`,
    )
  }
  // Brokered egress and an empty broker log: the guest never got a connection
  // out, not even a refused one. Its model could not have been reached, so a
  // "completed" result did not come from the run the user asked for. The
  // worker probes the socket at startup and names the fault in the log.
  const unreached = record.attestation.network === 'brokered' && record.egress.length === 0
  if (unreached) {
    const message =
      "No connection reached the egress broker: nothing could leave the container. The socket is a bind mount from the host; the log has the guest's reason."
    if (!record.result) return { failure: message, warnings }
    warnings.push(message)
  }

  if (!record.result) return { failure: 'The guest wrote no result', warnings }
  if (record.result.stopReason === 'error') {
    return { failure: record.result.error ?? 'The run ended with an error', warnings }
  }
  if (
    (record.carryOut.expected || record.result.commits.length > 0) &&
    record.carryOut.ref === null
  ) {
    return {
      failure: `The guest's commits could not be fetched: ${record.carryOut.error ?? 'unknown error'}`,
      warnings,
    }
  }
  // A secret that escaped the run outranks every other way it can end badly, so
  // it is judged before the cleanup problems below: a container left behind is
  // a chore, a leaked credential is an incident.
  if (record.secretCanary.present) {
    return { failure: `Secret canary leaked into the run: ${record.secretCanary.detail}`, warnings }
  }
  // Cleanup failed but the work itself is intact and retrievable: still not a
  // clean finish, because a container left running is the user's problem now.
  if (warnings.length > 0 && (record.cleanupError !== null || record.teardown === 'failed')) {
    return { failure: warnings[0] ?? 'Cleanup failed', warnings }
  }
  if (record.containerExit !== 0) {
    return {
      failure: `The container ended with ${record.containerExit === null ? 'unknown' : String(record.containerExit)} exit status`,
      warnings,
    }
  }
  return { failure: null, warnings }
}

/** Phase transitions the runner's log lines imply, without a second event channel. */
export function phaseFromLog(line: string, current: ContainerRunPhase): ContainerRunPhase {
  if (current === 'finished' || current === 'failed') return current
  if (line.includes('[thread-container] starting ')) return 'running'
  if (line.includes('[worker] installing dependencies')) return 'installing'
  if (
    current === 'installing' &&
    (line.includes('[worker] dependencies installed') ||
      line.includes('[worker] dependency install '))
  ) {
    return 'running'
  }
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
