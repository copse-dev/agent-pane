import { DEFAULT_APP_CHAT_MODEL, LM_STUDIO_MODEL_IDS } from '@shared/lm-studio-defaults.ts'
import { DEFAULT_CLOUD_MODEL } from '@shared/llm/model-catalog.ts'
import {
  REMOTE_AGENT_MODELS,
  REMOTE_AGENT_PROVIDER_CURSOR,
  parseRemoteAgentModel,
  type RemoteAgentProvider,
} from '@shared/remote-agent.ts'
import { isProviderKeyUsable } from './provider-key-status.ts'
import { buildProvider } from './provider-selection.ts'
import { isProviderAvailable } from './storage/settings.ts'

export interface ResolvedAgentChatModel {
  /** Model id actually used for the turn. */
  model: string
  /**
   * When the requested model could not run, a markdown status line prepended to
   * the assistant stream so the fallback is explicit in the transcript.
   */
  fallbackNotice?: string
}

function remoteProviderKeySlug(provider: RemoteAgentProvider): string {
  return provider === REMOTE_AGENT_PROVIDER_CURSOR ? 'cursor' : 'anthropic'
}

function remoteAgentLabel(provider: RemoteAgentProvider): string {
  return REMOTE_AGENT_MODELS.find((option) => option.provider === provider)?.label ?? 'Remote agent'
}

function localModelLabel(model: string): string {
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  return model
}

function buildFallbackNotice(input: {
  requestedLabel: string
  fallbackModel: string
  reason: string
}): string {
  const fallbackLabel = localModelLabel(input.fallbackModel)
  return (
    `_Could not run on **${input.requestedLabel}** (${input.reason}). ` +
    `This turn is running on **${fallbackLabel}** instead — pick another model in the footer or fix your key in Settings → Remote agents._\n\n`
  )
}

/** Prefer the default local chat model, then any configured cloud model. */
async function pickFallbackChatModel(): Promise<string> {
  const candidates = [
    DEFAULT_APP_CHAT_MODEL,
    `lmstudio:${LM_STUDIO_MODEL_IDS.chat}`,
    DEFAULT_CLOUD_MODEL,
    'claude-sonnet-4-6',
    'gpt-4o',
  ]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    try {
      await buildProvider(candidate)
      return candidate
    } catch {
      /* try next */
    }
  }
  if (isProviderAvailable('anthropic')) return DEFAULT_CLOUD_MODEL
  if (isProviderAvailable('openai')) return 'gpt-4o'
  return DEFAULT_APP_CHAT_MODEL
}

/**
 * Resolve the chat model for an agent turn. When the user picked a remote agent
 * but has no valid API key, fall back to a runnable local/cloud chat model and
 * return a notice so the transcript states what happened.
 */
export async function resolveAgentChatModel(requested: string): Promise<ResolvedAgentChatModel> {
  const remoteProvider = parseRemoteAgentModel(requested)
  if (!remoteProvider) return { model: requested }

  const slug = remoteProviderKeySlug(remoteProvider)
  if (await isProviderKeyUsable(slug)) return { model: requested }

  const fallbackModel = await pickFallbackChatModel()
  return {
    model: fallbackModel,
    fallbackNotice: buildFallbackNotice({
      requestedLabel: remoteAgentLabel(remoteProvider),
      fallbackModel,
      reason: 'no valid API key',
    }),
  }
}
