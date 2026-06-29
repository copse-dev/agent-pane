export const REMOTE_AGENT_MODEL_PREFIX = 'remote-agent:'

export const REMOTE_AGENT_PROVIDER_CURSOR = 'cursor'
export const REMOTE_AGENT_PROVIDER_ANTHROPIC = 'anthropic'

export const REMOTE_AGENT_PROVIDERS = [
  REMOTE_AGENT_PROVIDER_CURSOR,
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
] as const

export type RemoteAgentProvider = (typeof REMOTE_AGENT_PROVIDERS)[number]

export const DEFAULT_CURSOR_AGENT_BASE_URL = 'https://api.cursor.com'
export const DEFAULT_ANTHROPIC_AGENT_BASE_URL = 'https://api.anthropic.com'

export interface RemoteAgentModelOption {
  provider: RemoteAgentProvider
  value: `${typeof REMOTE_AGENT_MODEL_PREFIX}${RemoteAgentProvider}`
  label: string
}

export const REMOTE_AGENT_MODELS: readonly RemoteAgentModelOption[] = [
  {
    provider: REMOTE_AGENT_PROVIDER_CURSOR,
    value: `${REMOTE_AGENT_MODEL_PREFIX}${REMOTE_AGENT_PROVIDER_CURSOR}`,
    label: 'Cursor Cloud Agent',
  },
  {
    provider: REMOTE_AGENT_PROVIDER_ANTHROPIC,
    value: `${REMOTE_AGENT_MODEL_PREFIX}${REMOTE_AGENT_PROVIDER_ANTHROPIC}`,
    label: 'Claude Cloud Agent',
  },
]

export function isRemoteAgentModel(model: string): boolean {
  return parseRemoteAgentModel(model) !== null
}

export function parseRemoteAgentModel(model: string): RemoteAgentProvider | null {
  if (!model.startsWith(REMOTE_AGENT_MODEL_PREFIX)) return null
  const provider = model.slice(REMOTE_AGENT_MODEL_PREFIX.length)
  return REMOTE_AGENT_PROVIDERS.includes(provider as RemoteAgentProvider)
    ? (provider as RemoteAgentProvider)
    : null
}
