import { parseAcpModel } from '@shared/acp.ts'
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import { parseRemoteAgentModel, remoteAgentGroupLabel } from '@shared/remote-agent.ts'
import type { Message } from '@shared/types'

interface ChatAgentIdentity {
  key: string
  label: string
  style: 'riso' | 'duotone'
}

// Preinstalled/preset clients are not user-created identities.
export function customAgentId(model: string): string | null {
  const id = parseAcpModel(model)
  return id && !findAcpCatalogEntry(id) ? id : null
}

/** Read only the identity fields needed from the settings IPC boundary. */
export function namedAgentTitles(value: unknown): ReadonlyMap<string, string> {
  const titles = new Map<string, string>()
  const entries: readonly unknown[] = Array.isArray(value) ? value : []
  for (const entry of entries) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      typeof entry.id === 'string' &&
      'title' in entry &&
      typeof entry.title === 'string' &&
      entry.title.trim()
    )
      titles.set(entry.id, entry.title.trim())
  }
  return titles
}

export function chatAgentIdentity(
  threadId: string,
  message: Pick<Message, 'model' | 'requestedModel'>,
  names: ReadonlyMap<string, string>,
): ChatAgentIdentity | null {
  // Use message provenance, never the current picker or a thread-wide remote
  // link: an old Copse reply must not become a remote agent after a switch.
  // ACP replies can record only the requested route when the agent does not
  // report a resolved model. Prefer the concrete route when both are present.
  const model = message.model ?? message.requestedModel
  if (!model) return null
  const provider = parseRemoteAgentModel(model)
  if (provider) {
    return {
      key: `remote:${threadId}:${provider}`,
      label: remoteAgentGroupLabel(provider),
      style: 'duotone',
    }
  }
  const id = customAgentId(model)
  const label = id ? names.get(id) : undefined
  return id && label ? { key: `named:${id}`, label, style: 'riso' } : null
}
