import { isProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { getSetting } from '../storage/settings.ts'
import { getProjectThread } from '../thread-store.ts'
import type { TurnNeeds } from '../worker-protocol/worker-capabilities.ts'

/**
 * What a turn needs of the worker that runs it, read in the app before it
 * sends the turn: the model the turn runs on (the payload's, else the
 * thread's, else the default, as the turn itself resolves it), whether a
 * plugin with its own runtime is on, and whether the app confines commands.
 */
export async function turnNeeds(
  projectId: string,
  threadId: string,
  payloadModel: string | undefined,
): Promise<TurnNeeds> {
  const thread = await getProjectThread(projectId, threadId)
  const setting = getSetting<unknown>('model', undefined)
  return {
    model: payloadModel ?? thread?.model ?? (typeof setting === 'string' ? setting : undefined),
    pluginRuntimes: getPluginService().toolRuntimePluginIds().length > 0,
    sandbox: isProjectSandboxEnabled(),
  }
}
