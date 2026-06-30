import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { getSetting } from '../settings.ts'

/**
 * Settings-backed registry of external ACP agents Copse can drive (client role).
 * Agents are persisted under the `registeredAcpAgents` setting (validated by
 * `registeredAcpAgentsSchema`) and surfaced in the model picker as `acp:<id>`.
 *
 * This is the lookup half of the `acp:<id>` routing: the picker writes the model
 * value, `parseAcpModel` extracts the id, and {@link getAcpAgent} resolves it to
 * the spawn config the run service hands to the ACP client.
 */
export function listAcpAgents(): AcpAgentConfig[] {
  return getSetting<AcpAgentConfig[]>('registeredAcpAgents', [])
}

/** Configured agents the user has enabled — the ones the picker should offer. */
export function listEnabledAcpAgents(): AcpAgentConfig[] {
  return listAcpAgents().filter((agent) => agent.enabled)
}

/**
 * Resolve a configured agent by id. Returns `null` when no agent matches or the
 * matching agent is disabled, so a stale `acp:<id>` selection fails closed rather
 * than spawning something the user turned off.
 */
export function getAcpAgent(id: string): AcpAgentConfig | null {
  const agent = listAcpAgents().find((candidate) => candidate.id === id)
  return agent && agent.enabled ? agent : null
}
