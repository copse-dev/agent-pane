/**
 * The cloud-agent providers a thread's `remoteAgentLink` can name. Owned here
 * because the store persists and validates the value; the model-id parsing and
 * display logic for remote agents stays in the app (`src/shared/remote-agent.ts`),
 * which re-exports this vocabulary so existing imports are unchanged.
 */
export const REMOTE_AGENT_PROVIDER_CURSOR = 'cursor'
export const REMOTE_AGENT_PROVIDER_ANTHROPIC = 'anthropic'

export const REMOTE_AGENT_PROVIDERS = [
  REMOTE_AGENT_PROVIDER_CURSOR,
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
] as const

export type RemoteAgentProvider = (typeof REMOTE_AGENT_PROVIDERS)[number]

export function isRemoteAgentProvider(value: unknown): value is RemoteAgentProvider {
  return value === REMOTE_AGENT_PROVIDER_CURSOR || value === REMOTE_AGENT_PROVIDER_ANTHROPIC
}
