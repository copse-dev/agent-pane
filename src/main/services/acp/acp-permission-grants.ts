import { canonicalAcpAgentId, LEGACY_ACP_AGENT_IDS } from '@shared/acp-known-agents.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { parseStringList } from '../storage/storage-schema.ts'

/**
 * Remembered "always allow" grants for external ACP agents, mirroring the MCP
 * grant store (`mcp-registry.ts`). ACP permission requests carry no stable tool
 * name — titles embed the concrete command — so the only durable identity is
 * the agent plus the ACP tool *kind* (`execute`, `read`, `edit`, …). A grant
 * therefore covers every future request of that kind from that agent, which is
 * what the approval dialog's remember label spells out.
 *
 * A grant is also scoped to where the agent ran. One answered for a local agent
 * (often seatbelted) must not cover the same agent on an SSH host, where it runs
 * unsandboxed as the remote account; remote grants carry an `@remote` suffix on
 * the agent id, and local keys keep their original form so existing grants hold.
 */
const GRANTS_STORAGE_KEY = 'acp-remembered-grants'

/** Where the agent that asked for the permission runs. */
export type AcpGrantLocation = 'local' | 'remote'

function scopedId(agentId: string, location: AcpGrantLocation): string {
  return location === 'remote' ? `${agentId}@remote` : agentId
}

function grantKey(agentId: string, kind: string, location: AcpGrantLocation): string {
  return `${scopedId(canonicalAcpAgentId(agentId), location)}:${kind}`
}

/**
 * Every key a grant for this agent could be stored under: the current one, plus
 * one per id the agent used to have. Grants are written canonically, but a
 * grant remembered before the agent was renamed is still on disk under the old
 * id — and a dropped grant means re-prompting a user who already answered.
 */
function grantKeys(agentId: string, kind: string, location: AcpGrantLocation): string[] {
  const canonical = canonicalAcpAgentId(agentId)
  const legacy = Object.entries(LEGACY_ACP_AGENT_IDS)
    .filter(([, current]) => current === canonical)
    .map(([old]) => `${scopedId(old, location)}:${kind}`)
  return [grantKey(agentId, kind, location), ...legacy]
}

export function isAcpPermissionRemembered(
  agentId: string,
  kind: string,
  location: AcpGrantLocation = 'local',
): boolean {
  const stored = parseStringList(storageGet(GRANTS_STORAGE_KEY))
  return grantKeys(agentId, kind, location).some((key) => stored.includes(key))
}

/**
 * Persist a grant. Serialized read-modify-write so two grants stored at once
 * can't drop each other; the validated read discards corrupt entries on disk.
 */
export function rememberAcpPermission(
  agentId: string,
  kind: string,
  location: AcpGrantLocation = 'local',
): Promise<void> {
  return storageUpdate(GRANTS_STORAGE_KEY, (raw) => {
    const list = parseStringList(raw)
    const key = grantKey(agentId, kind, location)
    return list.includes(key) ? list : [...list, key]
  })
}
