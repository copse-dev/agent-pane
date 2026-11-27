import { isProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { getPluginToolRuntimeController } from '../plugins/plugin-tool-controller.ts'
import type { WorkerCapabilities } from '../worker-protocol/worker-capabilities.ts'

/**
 * What this turn host can run, for its hello. It runs Copse's own loop: no
 * external agent CLI or remote agent (`modelCannotRunInWorker`), no ChatGPT
 * sign-in it could save, and a plugin runtime only once it has a controller to
 * start one with. Its sandbox is the one its runtime set up at boot.
 */
export function turnHostCapabilities(): WorkerCapabilities {
  return {
    roles: ['turns'],
    models: { chatgptPlan: false, externalAgents: false, remoteAgents: false },
    pluginRuntimes: getPluginToolRuntimeController() !== null,
    sandbox: isProjectSandboxEnabled(),
  }
}
