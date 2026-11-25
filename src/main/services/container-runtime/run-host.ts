import { rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { isChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import type { ThreadContainerRecord } from '@shared/types/container-run.ts'
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

export interface ContainerRunHostRequest {
  runtimeId: string
  projectId: string
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
  )
  await mkdir(join(deps.hostFile, '..'), { recursive: true, mode: 0o700 })
  await writeFile(
    deps.hostFile,
    JSON.stringify({
      pid: process.pid,
      socket: deps.socketPath,
      runtimeId,
      projectId: request.projectId,
      threadId: base.threadId ?? null,
      startedAt: Date.now(),
    }),
    { mode: 0o600 },
  )

  let outcome: RunHostOutcome
  try {
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
    outcome = { status: 'done', record }
    final = { t: 'done', record }
  } catch (error) {
    outcome = { status: 'failed', error: errorMessage(error) }
    final = { t: 'failed', error: outcome.error }
  }
  deps.log(`${runtimeId}: ${outcome.status}`)
  server.broadcast(final)

  // Serve the result until the app has read it: it may still be connecting when
  // a run fails early. The record is on disk either way.
  const deadline = Date.now() + (deps.lingerMs ?? 30_000)
  while ((!app.attached || server.joined() > 0) && Date.now() < deadline) await delay(100)
  await server.close()
  await rm(deps.hostFile, { force: true })
  return outcome
}
