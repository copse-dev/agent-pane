import { z } from 'zod'
import { isChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import { isAcpModel } from '@shared/acp.ts'
import { isRemoteAgentModel } from '@shared/remote-agent.ts'
import { parsePluginModelSelection } from '@shared/plugin-model.ts'

/**
 * What a harness worker says it can run, in its `hello`
 * (`docs/plans/harness-worker-roadmap.md`, R2).
 *
 * A worker is any process that runs turns or runs for the app: the resident
 * turn host today, the container run host, and later a worker on an SSH host
 * or a cloud machine. Each says what it can do when a client connects, and the
 * client sends a worker only what the worker said it can run, so a turn never
 * starts somewhere it would quietly lose a tool, a sign-in or its sandbox.
 *
 * Every field is a plain yes or no that a worker on another machine can answer
 * about itself. A field a worker leaves out counts as no.
 */

/** The jobs a worker takes: turns of a thread, or one container run. */
export const WORKER_ROLES = ['turns', 'container-run'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

export interface WorkerCapabilities {
  roles: WorkerRole[]
  /** Kinds of model the worker can run a turn on, beyond Copse's own loop. */
  models: {
    /** A ChatGPT-plan sign-in, whose refreshed tokens the worker can save. */
    chatgptPlan: boolean
    /** An external coding agent over ACP, hosted by the worker. */
    externalAgents: boolean
    /** A remote agent the worker connects to. */
    remoteAgents: boolean
  }
  /** Plugins whose tools and models run in a runtime of their own. */
  pluginRuntimes: boolean
  /** Whether project commands spawn confined by the OS sandbox there. */
  sandbox: boolean
}

export const workerCapabilitiesSchema = z.object({
  roles: z.array(z.enum(WORKER_ROLES)).max(WORKER_ROLES.length),
  models: z.object({
    chatgptPlan: z.boolean(),
    externalAgents: z.boolean(),
    remoteAgents: z.boolean(),
  }),
  pluginRuntimes: z.boolean(),
  sandbox: z.boolean(),
})

/** A worker that said nothing about itself: it can run nothing. */
export const NO_CAPABILITIES: WorkerCapabilities = {
  roles: [],
  models: { chatgptPlan: false, externalAgents: false, remoteAgents: false },
  pluginRuntimes: false,
  sandbox: false,
}

/** What one turn needs of the worker that runs it, as the app sees the thread. */
export interface TurnNeeds {
  /** The model the turn runs on, when the app knows it. */
  model: string | undefined
  /** Plugins with their own runtime are on in the app, so the turn may call them. */
  pluginRuntimes: boolean
  /** The app confines project commands, so the worker must too. */
  sandbox: boolean
}

/**
 * Why a worker cannot run this turn, in words for the log, or null when it can.
 * The app runs a turn it gets a reason for itself, as for a refused dispatch.
 */
export function turnCannotRunOn(capabilities: WorkerCapabilities, needs: TurnNeeds): string | null {
  if (!capabilities.roles.includes('turns')) return 'the worker does not run turns'
  const { model } = needs
  if (model !== undefined) {
    if (isChatGptPlanModel(model) && !capabilities.models.chatgptPlan)
      return 'its model signs in with ChatGPT, whose tokens the worker cannot save'
    if (isAcpModel(model) && !capabilities.models.externalAgents)
      return 'it runs on an external coding agent, which the worker does not host'
    if (isRemoteAgentModel(model) && !capabilities.models.remoteAgents)
      return 'it runs on a remote agent, which the worker does not connect to'
    if (parsePluginModelSelection(model) !== null && !capabilities.pluginRuntimes)
      return "its model is a plugin's, and the worker runs no plugin runtimes"
  }
  if (needs.pluginRuntimes && !capabilities.pluginRuntimes)
    return 'a plugin with its own tools is on, and the worker runs no plugin runtimes'
  if (needs.sandbox && !capabilities.sandbox)
    return 'the app confines project commands, and the worker cannot'
  return null
}
