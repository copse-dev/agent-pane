/**
 * How an ACP agent config travels into a container run, in both directions
 * (`docs/plans/thread-in-container.md`, decisions A1 and A5). Pure, so both
 * ends are unit-tested without a container.
 */
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import { containerAcpAgent } from '@shared/container-acp-agents.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import type { ThreadContainerAcpHarness } from './thread-container.ts'

/**
 * The host side: what of a registered agent may cross into the run spec.
 *
 * The command is the catalogue's, not the user's — the image bakes the binary
 * under its catalogue name, and a config may point at an absolute path on the
 * desktop. The user's `env` map is dropped whole: it is where they keep their
 * own keys, and the run is given exactly one credential (decision A1). What
 * survives is the agent's identity and the per-session choices the guest
 * applies over the protocol: model, session mode, config options. A config
 * that names a retired adapter runs under the entry the image carries for it.
 */
export function acpHarnessForContainer(
  agent: AcpAgentConfig,
  keyEnvName: string,
): ThreadContainerAcpHarness {
  const id = containerAcpAgent(agent.id)?.id ?? agent.id
  const catalogue = findAcpCatalogEntry(id)
  return {
    agent: {
      id,
      title: agent.title,
      command: catalogue?.command ?? agent.command,
      args: catalogue?.args ?? agent.args ?? [],
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
      ...(agent.configOptions ? { configOptions: agent.configOptions } : {}),
      // The container is the sandbox (decision A5): a second bubblewrap with
      // its own network scope inside `--network=none` is nothing we want to own.
      sandbox: false,
      enabled: true,
    },
    keyEnvName,
  }
}

/**
 * The guest side: the agent as the worker registers it for the run. The key
 * the worker consumed from its environment becomes the agent's one variable;
 * an empty key (a scripted agent under test) sets nothing.
 */
export function guestAcpAgentConfig(
  harness: ThreadContainerAcpHarness,
  apiKey: string,
): AcpAgentConfig {
  return {
    ...harness.agent,
    ...(apiKey ? { env: { [harness.keyEnvName]: apiKey } } : {}),
    sandbox: false,
    enabled: true,
  }
}
