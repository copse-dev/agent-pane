import { storageGet, storageUpdate } from '../storage.ts'
import { parseStringList } from '../storage-schema.ts'

/**
 * Remembered "always allow" grants for external ACP agents, mirroring the MCP
 * grant store (`mcp-registry.ts`). ACP permission requests carry no stable tool
 * name — titles embed the concrete command — so the only durable identity is
 * the agent plus the ACP tool *kind* (`execute`, `read`, `edit`, …). A grant
 * therefore covers every future request of that kind from that agent, which is
 * what the approval dialog's remember label spells out.
 */
const GRANTS_STORAGE_KEY = 'acp-remembered-grants'

function grantKey(agentId: string, kind: string): string {
  return `${agentId}:${kind}`
}

export function isAcpPermissionRemembered(agentId: string, kind: string): boolean {
  return parseStringList(storageGet(GRANTS_STORAGE_KEY)).includes(grantKey(agentId, kind))
}

/**
 * Persist a grant. Serialized read-modify-write so two grants stored at once
 * can't drop each other; the validated read discards corrupt entries on disk.
 */
export function rememberAcpPermission(agentId: string, kind: string): Promise<void> {
  return storageUpdate(GRANTS_STORAGE_KEY, (raw) => {
    const list = parseStringList(raw)
    const key = grantKey(agentId, kind)
    return list.includes(key) ? list : [...list, key]
  })
}
