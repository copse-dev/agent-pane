import type { AcpAgentConfig, AcpAgentSandboxConfig } from '@shared/types/acp.ts'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { getSetting, setSetting } from '../storage/settings.ts'

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

/**
 * Resolve the seatbelt confines an agent should spawn under (issue #590). The
 * `KNOWN_ACP_AGENTS` catalog is the source of truth for presets — resolved
 * here at spawn time rather than copied into the persisted config, so catalog
 * updates apply without config migrations. The config's `sandbox` field is an
 * override only: an object replaces the catalog preset, `false` opts the agent
 * out, and absence means "whatever the catalog says" (custom agents with no
 * catalog entry spawn unsandboxed).
 */
export function resolveAcpSandbox(config: AcpAgentConfig): AcpAgentSandboxConfig | undefined {
  if (config.sandbox === false) return undefined
  if (config.sandbox) return config.sandbox
  return KNOWN_ACP_AGENTS.find((known) => known.id === config.id)?.sandbox
}

/**
 * Insert or replace an agent config by id and persist the list. Used by
 * auto-setup to register a preset (and later stamp its detected models) without
 * the renderer round-trip. Returns the updated list.
 */
export async function upsertAcpAgent(config: AcpAgentConfig): Promise<AcpAgentConfig[]> {
  const list = listAcpAgents()
  const index = list.findIndex((candidate) => candidate.id === config.id)
  const next = index === -1 ? [...list, config] : list.map((c) => (c.id === config.id ? config : c))
  await setSetting('registeredAcpAgents', next)
  return next
}
