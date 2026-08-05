import { FALLBACK_APP_CHAT_MODEL, LM_STUDIO_MODEL_IDS } from '@shared/lm-studio-defaults.ts'
import { isDynamicModel } from '@copse/llm/dynamic-model.ts'
import { DEFAULT_CLOUD_MODEL } from '@copse/llm/model-catalog.ts'
import {
  REMOTE_AGENT_MODELS,
  REMOTE_AGENT_PROVIDER_CURSOR,
  parseRemoteAgentModel,
  parseRemoteAgentModelSelection,
  type RemoteAgentProvider,
} from '@shared/remote-agent.ts'
import { isProviderKeyUsable } from './provider-key-status.ts'
import { buildProvider } from './provider-selection.ts'
import { isProviderAvailable } from '../storage/settings.ts'
import { resolveDynamicModelId } from './dynamic-model.ts'

export interface ResolvedAgentChatModel {
  /** Model id actually used for the turn. */
  model: string
  /**
   * When the requested model could not run, a markdown status line prepended to
   * the assistant stream so the fallback is explicit in the transcript.
   */
  fallbackNotice?: string
  /**
   * Set when the user picked a remote agent whose provider key is unusable, so
   * `model` is a stand-in rather than what they asked for. Interactive turn
   * paths use it to offer a subscription-billed ACP agent before accepting the
   * demotion to a local chat model; non-interactive callers (post-turn review,
   * model comparison) ignore it and just run on `model`.
   */
  blockedRemoteAgent?: {
    provider: RemoteAgentProvider
    /** Upstream model half of the selection, when the picker pinned one. */
    model?: string
  }
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
    FALLBACK_APP_CHAT_MODEL,
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
  return FALLBACK_APP_CHAT_MODEL
}

/**
 * Resolve the chat model for an agent turn. Expands a dynamic selection
 * (`auto:…`) to a concrete routable model. A remote-agent selection is honoured
 * whenever its provider key is usable — the Claude Cloud Agent runs the managed
 * Agents API, which is API-key billed and has no subscription equivalent, so a
 * user who picked it gets it.
 *
 * When the key is unusable the turn cannot run as asked: fall back to a runnable
 * local/cloud chat model, return a notice so the transcript states what
 * happened, and flag the blocked selection so an interactive caller can offer a
 * subscription-billed ACP agent instead of accepting the demotion silently.
 */
export async function resolveAgentChatModel(requested: string): Promise<ResolvedAgentChatModel> {
  // Selector expansion first: a dynamic selection never resolves to a
  // remote-agent id, so the remote-agent handling below only ever sees the
  // user's literal choice — an unexpanded selector would fall through as a bare
  // model id and be handed to a provider that has never heard of it.
  if (isDynamicModel(requested)) {
    return { model: await resolveDynamicModelId(requested) }
  }

  const remoteProvider = parseRemoteAgentModel(requested)
  if (!remoteProvider) return { model: requested }

  const slug = remoteProviderKeySlug(remoteProvider)
  if (await isProviderKeyUsable(slug)) return { model: requested }

  const fallbackModel = await pickFallbackChatModel()
  const selection = parseRemoteAgentModelSelection(requested)
  return {
    model: fallbackModel,
    fallbackNotice: buildFallbackNotice({
      requestedLabel: remoteAgentLabel(remoteProvider),
      fallbackModel,
      reason: 'no valid API key',
    }),
    blockedRemoteAgent: {
      provider: remoteProvider,
      ...(selection?.model ? { model: selection.model } : {}),
    },
  }
}
