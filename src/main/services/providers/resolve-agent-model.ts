import {
  FALLBACK_APP_CHAT_MODEL,
  isBestValueChatModel,
  LM_STUDIO_MODEL_IDS,
} from '@shared/lm-studio-defaults.ts'
import { DEFAULT_CLOUD_MODEL } from '@copse/llm/model-catalog.ts'
import {
  REMOTE_AGENT_MODELS,
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
  REMOTE_AGENT_PROVIDER_CURSOR,
  parseRemoteAgentModel,
  parseRemoteAgentModelSelection,
  type RemoteAgentProvider,
} from '@shared/remote-agent.ts'
import { acpModelValue } from '@shared/acp.ts'
import { isProviderKeyUsable } from './provider-key-status.ts'
import { buildProvider } from './provider-selection.ts'
import { getSetting, isProviderAvailable } from '../storage/settings.ts'
import { listEnabledAcpAgents } from '../acp/acp-agent-registry.ts'
import { resolveBestValueChatModel } from './best-value-model.ts'

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

/** ACP agent ids that are Claude-based and use subscription billing. */
const CLAUDE_ACP_AGENT_IDS = new Set(['claude-agent-acp', 'claude-code-acp'])

/**
 * When the user selected Claude Cloud Agent (`remote-agent:anthropic`) and has
 * an enabled ACP Claude agent, redirect to the ACP path so turns are
 * subscription-billed rather than API-key-billed. Returns the ACP model value,
 * or `null` to stay on the Cloud Agent path.
 */
function tryAcpClaudeRedirect(requested: string): string | null {
  if (!getSetting<boolean>('preferAcpOverCloudAgent', true)) return null
  const selection = parseRemoteAgentModelSelection(requested)
  if (!selection || selection.provider !== REMOTE_AGENT_PROVIDER_ANTHROPIC) return null

  const enabled = listEnabledAcpAgents()
  const claude = enabled.find((agent) => CLAUDE_ACP_AGENT_IDS.has(agent.id))
  if (!claude) return null

  return acpModelValue(claude.id, selection.model)
}

/**
 * Resolve the chat model for an agent turn. Expands the best-value sentinel to a
 * concrete routable model; when the user picked a remote agent but has no valid
 * API key, fall back to a runnable local/cloud chat model and return a notice
 * so the transcript states what happened.
 *
 * When `preferAcpOverCloudAgent` is on (default) and a Claude Cloud Agent
 * request can be served by an enabled ACP Claude agent, redirect to the ACP
 * path so turns count against subscription headroom instead of API credit.
 */
export async function resolveAgentChatModel(requested: string): Promise<ResolvedAgentChatModel> {
  // Sentinel expansion first: the best-value value is never a remote-agent
  // selection, so the ACP redirect below still sees the user's literal choice.
  if (isBestValueChatModel(requested)) {
    return { model: await resolveBestValueChatModel() }
  }

  const acpRedirect = tryAcpClaudeRedirect(requested)
  if (acpRedirect) {
    return {
      model: acpRedirect,
      fallbackNotice:
        '_Using **Claude Code (ACP)** instead of Claude Cloud Agent — subscription-billed, no API key cost._\n\n',
    }
  }

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
