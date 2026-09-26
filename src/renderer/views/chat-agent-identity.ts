import { parseAcpAgentConfigs, parseAcpModel, parseAcpModelSelection } from '@shared/acp.ts'
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import {
  parseRemoteAgentModel,
  parseRemoteAgentModelSelection,
  remoteAgentGroupLabel,
} from '@shared/remote-agent.ts'
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

/** Named agents' display titles, decoded from the settings IPC boundary. */
export function namedAgentTitles(value: unknown): ReadonlyMap<string, string> {
  const titles = new Map<string, string>()
  for (const agent of parseAcpAgentConfigs(value)) {
    const title = agent.title.trim()
    if (title) titles.set(agent.id, title)
  }
  return titles
}

/** The concrete model an agent route names (`acp:maple#model-a` → `model-a`), if any. */
export function agentRouteModel(model: string): string | undefined {
  return parseAcpModelSelection(model)?.model ?? parseRemoteAgentModelSelection(model)?.model
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
