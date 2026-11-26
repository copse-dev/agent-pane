import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { isChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import type { ContainerRunProgress, ThreadContainerRecord } from '@shared/types/container-run.ts'
import { errorMessage } from '@shared/errors.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { localSocketPath, serveLocalLine } from '../local-socket.ts'
import type {
  ContainerProviderPlan,
  resolveContainerProvider,
} from '../providers/container-provider.ts'
import { DEPENDENCY_INSTALL_ORIGINS } from './guest-install.ts'
import type {
  RunThreadOptions,
  runThreadInContainer,
  ThreadContainerRequest,
} from './thread-container.ts'
import type { WorkerPhase } from './worker-events.ts'

/**
 * The host side of one container run, in a process of its own
 * (`docs/plans/local-turn-worker.md`, "Container runs").
 *
 * The app arms the run and hands this process only what it can say in plain
 * data. The process resolves the provider itself from the profile, so no key
 * travels through argv, the environment or a file, and refuses to run when the
 * network access it arrives at is not what the user armed. It then owns the
 * guest's stdio link, the egress broker and host inference until the run ends,
 * and reports progress over a local line (`local-socket.ts`).
 */

/** What a run needs besides its provider: all of it plain data. */
export type ContainerRunBase = Omit<
  ThreadContainerRequest,
  | 'model'
  | 'provider'
  | 'hostInference'
  | 'contextWindow'
  | 'apiKey'
  | 'acp'
  | 'egressResolve'
  | 'runtimesDir'
  | 'maxSteps'
>

/**
 * What the app showed for the run when it started it, kept by the host so an
 * app relaunched mid-run can show the same run again.
 */
export type ContainerRunHostDisplay = Omit<
  ContainerRunProgress,
  'runtimeId' | 'phase' | 'finishedAt' | 'log' | 'warnings' | 'record' | 'error'
>

export interface ContainerRunHostRequest {
  runtimeId: string
  projectId: string
  display: ContainerRunHostDisplay
  /** The user's model selection, as the app resolved it. */
  model: string
  useAgentLogin: boolean
  base: ContainerRunBase
}

export type AppToRunHost = { t: 'attach' } | { t: 'stop' }

export type RunHostToApp =
  | { t: 'state'; phase: WorkerPhase | null; log: string[] }
  | { t: 'log'; line: string }
  | { t: 'phase'; phase: WorkerPhase }
  | { t: 'done'; record: ThreadContainerRecord }
  | { t: 'failed'; error: string }

const appToRunHostSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('attach') }),
  z.object({ t: z.literal('stop') }),
])

const phaseSchema = z.enum(['installing', 'running', 'collecting'])

// The record comes from this user's own host, written by the same code that
// writes it in the app; the envelope is checked, the record is not.
export const runHostToAppSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('state'), phase: phaseSchema.nullable(), log: z.array(z.string()) }),
  z.object({ t: z.literal('log'), line: z.string() }),
  z.object({ t: z.literal('phase'), phase: phaseSchema }),
  z.object({
    t: z.literal('done'),
    record: z.custom<ThreadContainerRecord>((value) => isRecord(value)),
  }),
  z.object({ t: z.literal('failed'), error: z.string() }),
])

export const containerRunHostRequestSchema = z.object({
  runtimeId: z.string().regex(/^run-[\w-]+$/),
  projectId: z.string().min(1),
  model: z.string().min(1),
  useAgentLogin: z.boolean(),
  display: z.custom<ContainerRunHostDisplay>(
    (value) => isRecord(value) && typeof value['threadId'] === 'string',
  ),
  base: z.custom<ContainerRunBase>(
    (value) =>
      isRecord(value) &&
      typeof value['workspace'] === 'string' &&
      typeof value['prompt'] === 'string' &&
      Array.isArray(value['egressAllowlist']),
  ),
})

/** The origins a run may reach: what its provider needs, and installs if asked for. */
export function armedEgress(plan: ContainerProviderPlan, installDependencies: boolean): string[] {
  return [...new Set([...plan.egress, ...(installDependencies ? DEPENDENCY_INSTALL_ORIGINS : [])])]
}

/** The run's full request, with the provider the plan resolved. */
export function withProvider(
  base: ContainerRunBase,
  plan: ContainerProviderPlan,
): ThreadContainerRequest {
  return {
    ...base,
    model: plan.model,
    ...(plan.mode === 'host-inference'
      ? { hostInference: plan.hostInference, contextWindow: plan.contextWindow }
      : { acp: plan.harness }),
    // The key stays in memory: the runner hands it to the guest over the
    // container's stdio link (decision A17).
    ...(plan.apiKey ? { apiKey: plan.apiKey } : {}),
  }
}

/**
 * Whether a run on `model` can have its host side outside the app. A ChatGPT
 * plan sign-in can rotate its refresh token when host inference refreshes it,
 * and a host on a read-only profile could not save the new one.
 */
export function canHostOutsideApp(model: string): boolean {
  return !isChatGptPlanModel(model)
}

export function runHostSocketPath(userDataPath: string, runtimeId: string): string {
  return localSocketPath(userDataPath, 'container-run', runtimeId)
}

/** Where a live host says who it is, so a relaunched app can find it. */
export function runHostFilePath(userDataPath: string, runtimeId: string): string {
  return join(userDataPath, 'container-hosts', `${runtimeId}.json`)
}

/** `container-hosts/<runtime>.json`: a live host, as a relaunched app finds it. */
export interface RunHostFile {
  pid: number
  socket: string
  runtimeId: string
  projectId: string
  display: ContainerRunHostDisplay
}

const runHostFileSchema = z.object({
  pid: z.number().int().positive(),
  socket: z.string().min(1),
  runtimeId: z.string().regex(/^run-[\w-]+$/),
  projectId: z.string().min(1),
  display: z.custom<ContainerRunHostDisplay>(
    (value) =>
      isRecord(value) &&
      typeof value['threadId'] === 'string' &&
      typeof value['prompt'] === 'string',
  ),
})

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: gone. EPERM: another user's process reusing the pid, never ours.
    return false
  }
}

/**
 * Hosts in this profile still running a run, for a relaunched app to follow.
 * A file whose process is gone is removed: that host ended without cleaning
 * up, and its run settles from what its record says.
 */
export async function listLiveRunHosts(
  userDataPath: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<RunHostFile[]> {
  const dir = join(userDataPath, 'container-hosts')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const live: RunHostFile[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.request.json')) continue
    const path = join(dir, name)
    let parsed: RunHostFile | null
    try {
      const result = runHostFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
      parsed = result.success ? result.data : null
    } catch {
      parsed = null
    }
    if (parsed !== null && alive(parsed.pid)) live.push(parsed)
    else await rm(path, { force: true })
  }
  return live
}

export interface RunHostDependencies {
  resolve: typeof resolveContainerProvider
  run: typeof runThreadInContainer
  socketPath: string
  hostFile: string
  log: (line: string) => void
  /** How long to keep serving the result for an app that has not read it. */
  lingerMs?: number
}

export type RunHostOutcome =
  | { status: 'done'; record: ThreadContainerRecord }
  | { status: 'failed'; error: string }

const LOG_TAIL = 60

/**
 * How long a started host waits for the app to attach: the app's own connect
 * deadline (`run-host-client.ts`). An app that never arrives is gone.
 */
const APP_ATTACH_TIMEOUT_MS = 30_000

function sameOrigins(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((origin) => right.has(origin))
}

/** Run one container run's host side, serving its progress until it ends. */
export async function hostContainerRun(
  request: ContainerRunHostRequest,
  deps: RunHostDependencies,
): Promise<RunHostOutcome> {
  const { base, runtimeId } = request
  const stop = new AbortController()
  let phase: WorkerPhase | null = null
  let log: string[] = []
  let final: Extract<RunHostToApp, { t: 'done' | 'failed' }> | null = null
  const app = { attached: false }

  const server = await serveLocalLine<AppToRunHost, RunHostToApp>(
    deps.socketPath,
    appToRunHostSchema,
    (message, client) => {
      if (message.t === 'stop') {
        deps.log(`${runtimeId}: stop asked for`)
        stop.abort()
        return
      }
      // Join before the reply, so the state and the lines after it arrive in order.
      app.attached = true
      client.join()
      client.send({ t: 'state', phase, log })
      if (final !== null) client.send(final)
    },
    () => {
      // The app can't attach to a run again yet, so a run whose app left (a
      // crash, a force quit) has nobody to see or stop it. Stop it, as the
      // guest stops when its own host goes (decision A8).
      if (final !== null || server.joined() > 0) return
      deps.log(`${runtimeId}: the app left; stopping`)
      stop.abort()
    },
  )
  const attachTimer = setTimeout(() => {
    if (app.attached) return
    deps.log(`${runtimeId}: no app attached; stopping`)
    stop.abort()
  }, APP_ATTACH_TIMEOUT_MS)
  attachTimer.unref()
  await mkdir(join(deps.hostFile, '..'), { recursive: true, mode: 0o700 })
  const hostFile: RunHostFile = {
    pid: process.pid,
    socket: deps.socketPath,
    runtimeId,
    projectId: request.projectId,
    display: request.display,
  }
  await writeFile(deps.hostFile, JSON.stringify(hostFile), { mode: 0o600 })

  let outcome: RunHostOutcome
  try {
    if (stop.signal.aborted) throw new Error('Stopped before the run started')
    if (!canHostOutsideApp(request.model)) {
      throw new Error('A run on a ChatGPT plan model runs in the app')
    }
    const plan = await deps.resolve(request.model, {
      useAgentLogin: request.useAgentLogin,
      ...(base.threadId !== undefined ? { threadId: base.threadId } : {}),
    })
    if (!sameOrigins(armedEgress(plan, base.installDependencies === true), base.egressAllowlist)) {
      throw new Error(
        "The run's network access changed after you started it; start the run again to review it",
      )
    }
    const record = await deps.run(withProvider(base, plan), {
      runtimeId,
      onLog: (line): void => {
        log = [...log, line].slice(-LOG_TAIL)
        server.broadcast({ t: 'log', line })
      },
      onPhase: (next): void => {
        phase = next
        server.broadcast({ t: 'phase', phase: next })
      },
      signal: stop.signal,
    } satisfies RunThreadOptions)
    clearTimeout(attachTimer)
    outcome = { status: 'done', record }
    final = { t: 'done', record }
  } catch (error) {
    outcome = { status: 'failed', error: errorMessage(error) }
    final = { t: 'failed', error: outcome.error }
  }
  clearTimeout(attachTimer)
  deps.log(
    outcome.status === 'failed'
      ? `${runtimeId}: failed: ${outcome.error}`
      : `${runtimeId}: ${outcome.status}`,
  )
  server.broadcast(final)

  // Serve the result until the app has read it: it may still be connecting when
  // a run fails early. The record is on disk either way.
  const deadline = Date.now() + (deps.lingerMs ?? 30_000)
  while ((!app.attached || server.joined() > 0) && Date.now() < deadline) await delay(100)
  await server.close()
  await rm(deps.hostFile, { force: true })
  return outcome
}
