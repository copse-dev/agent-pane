import type { AcpAgentConfig, AcpAgentSandboxConfig } from '@shared/types/acp.ts'
import { canonicalAcpAgentId, findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { runSerialized } from '../storage/write-queue.ts'

interface AcpAgentStore {
  read: () => AcpAgentConfig[]
  write: (agents: AcpAgentConfig[]) => Promise<void>
}

const acpAgentStore: AcpAgentStore = {
  read: listAcpAgents,
  write: (agents) => setSetting('registeredAcpAgents', agents),
}

const ACP_AGENT_REGISTRY_MUTATION_QUEUE = 'acp-agent-registry:mutation'

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
  // Normalise renamed ids on the way out (`LEGACY_ACP_AGENT_IDS`), so a config
  // written before an agent was renamed still resolves its catalog entry — and
  // therefore its seatbelt — rather than silently reading as a custom agent.
  return getSetting<AcpAgentConfig[]>('registeredAcpAgents', []).map((agent) =>
    agent.id === canonicalAcpAgentId(agent.id)
      ? agent
      : { ...agent, id: canonicalAcpAgentId(agent.id) },
  )
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
  // `id` often comes from a thread's `acp:<id>` model value, which is history
  // and keeps whatever id was current when the turn ran.
  const canonical = canonicalAcpAgentId(id)
  const agent = listAcpAgents().find((candidate) => candidate.id === canonical)
  return agent && agent.enabled ? agent : null
}

/**
 * Resolve the seatbelt confines an agent should spawn under (issue #590). The
 * catalog is the source of truth for presets — resolved here at spawn time
 * rather than copied into the persisted config, so catalog updates apply
 * without config migrations. That read-through is why the lookup spans retired
 * entries too (`findAcpCatalogEntry`): withdrawing an agent must not quietly
 * drop the seatbelt from a config that still names it. The config's `sandbox` field is an
 * override only: an object replaces the catalog preset, `false` opts the agent
 * out, and absence means "whatever the catalog says" (custom agents with no
 * catalog entry spawn unsandboxed).
 */
export function resolveAcpSandbox(config: AcpAgentConfig): AcpAgentSandboxConfig | undefined {
  if (config.sandbox === false) return undefined
  if (config.sandbox) return config.sandbox
  return findAcpCatalogEntry(config.id)?.sandbox
}

/**
 * Resolve the ACP **session mode** an agent should start each session in
 * (issue #607). A user-set `permissionMode` on the config always wins. Absent,
 * we fall back to the catalog's `sandboxedPermissionMode`
 * **only when the agent will actually spawn sandboxed** — the seatbelt makes
 * prompt-per-edit friction without safety, so the Claude presets relax to
 * `acceptEdits`. Unsandboxed agents (and any agent with no catalog default)
 * keep their own default prompting. Returns `undefined` for "agent default".
 *
 * `sandboxed` is the caller's `willSandboxAcpAgent(...)` result, so this stays
 * in lockstep with the spawn decision (platform + project-sandbox gating).
 */
export function resolveAcpPermissionMode(
  config: AcpAgentConfig,
  sandboxed: boolean,
): string | undefined {
  if (config.permissionMode) return config.permissionMode
  if (!sandboxed) return undefined
  return findAcpCatalogEntry(config.id)?.sandboxedPermissionMode
}

/**
 * Insert or replace an agent config by id and persist the list. Used by
 * auto-setup to register a preset (and later stamp its detected models) without
 * the renderer round-trip. Returns the updated list.
 */
export async function upsertAcpAgent(
  config: AcpAgentConfig,
  store: AcpAgentStore = acpAgentStore,
): Promise<AcpAgentConfig[]> {
  const normalized = { ...config, id: canonicalAcpAgentId(config.id) }
  return runSerialized(ACP_AGENT_REGISTRY_MUTATION_QUEUE, async () => {
    const list = store.read()
    const index = list.findIndex((candidate) => candidate.id === normalized.id)
    const next =
      index === -1
        ? [...list, normalized]
        : list.map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
    await store.write(next)
    return next
  })
}
