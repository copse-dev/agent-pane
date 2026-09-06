import { OPENROUTER_BASE_URL, isOpenRouterModel, openRouterModelId } from '@copse/llm/openrouter.ts'
import {
  ACP_MODEL_PREFIX,
  PLUGIN_MODEL_PREFIX,
  REMOTE_AGENT_MODEL_PREFIX,
} from '@copse/llm/reserved-prefixes.ts'
import { extraProviderForModel, extraProviderModelId } from '@copse/llm/extra-providers.ts'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import { containerAcpAgent, containerAcpAvailability } from '@shared/container-acp-agents.ts'
import { LM_STUDIO_MODEL_IDS, resolveLocalServerUrl } from '@shared/lm-studio-defaults.ts'
import { getAcpAgent } from '../acp/acp-agent-registry.ts'
import { acpHarnessForContainer } from '../container-runtime/guest-acp-agent.ts'
import type { ThreadContainerAcpHarness } from '../container-runtime/thread-container.ts'
import { getLmStudioApiKey, getSetting, resolveApiKey } from '../storage/settings.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'

/**
 * How a container run reaches the model for a given product model id
 * (`docs/plans/thread-in-container.md`). The guest has no network; the host
 * brokers exactly one origin for the model, so this must name it up front.
 *
 * Three shapes, because the guest speaks three dialects:
 * - `openai-compatible`: the guest's OpenAI-compatible client talks to `url`
 *   (LM Studio and other local servers, OpenAI, OpenRouter, extra providers).
 * - `product`: the guest resolves the provider itself from the model id and
 *   one API key, the way the desktop does — needed for Anthropic, whose SDK is
 *   not OpenAI-compatible.
 * - `acp`: the guest runs an external agent baked into the image, under its
 *   vendor's API key, and the allowlist is the agent's catalogue domains
 *   (`docs/plans/thread-in-container.md`, "Agent models in the guest").
 *
 * `apiKey` is returned to the caller, which hands it to the run through an
 * environment variable and never writes it anywhere. `egress` is the rules the
 * broker admits for it: one origin for a provider, a vendor's domains for an
 * agent.
 */
export type ContainerProviderPlan =
  | {
      mode: 'openai-compatible'
      /** The model id the endpoint expects (prefix stripped). */
      model: string
      url: string
      apiKey: string | null
      egress: string[]
    }
  | {
      mode: 'product'
      model: string
      apiKeySlug: string
      apiKey: string
      egress: string[]
    }
  | {
      mode: 'acp'
      /** The full `acp:<id>[#model]` value; the guest routes it as the desktop would. */
      model: string
      harness: ThreadContainerAcpHarness
      apiKey: string
      egress: string[]
    }

function originOf(url: string): string {
  const parsed = new URL(url)
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return `${parsed.hostname}:${String(port)}`
}

export function resolveContainerProvider(model: string): ContainerProviderPlan {
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = resolveLocalServerUrl(getSetting<string>('localServerUrl', ''), process.env)
    const configured = model.startsWith('lmstudio:') ? model.slice('lmstudio:'.length) : ''
    const id = configured || LM_STUDIO_MODEL_IDS.chat
    return {
      mode: 'openai-compatible',
      model: id,
      url,
      apiKey: getLmStudioApiKey() || null,
      egress: [originOf(url)],
    }
  }
  if (isOpenRouterModel(model)) {
    const apiKey = resolveApiKey('openrouter')
    if (!apiKey) throw new Error('OpenRouter is not configured; add an API key in Settings.')
    return {
      mode: 'openai-compatible',
      model: openRouterModelId(model),
      url: OPENROUTER_BASE_URL,
      apiKey,
      egress: [originOf(OPENROUTER_BASE_URL)],
    }
  }
  const extra = extraProviderForModel(getResolvedExtraProviders(), model)
  if (extra) {
    const apiKey = resolveApiKey(extra.id)
    if (!apiKey && !extra.local) {
      throw new Error(`${extra.label} is not configured; add an API key in Settings.`)
    }
    return {
      mode: 'openai-compatible',
      model: extraProviderModelId(model),
      url: extra.baseUrl,
      apiKey,
      egress: [originOf(extra.baseUrl)],
    }
  }
  if (model.startsWith('claude')) {
    const apiKey = resolveApiKey('anthropic')
    if (!apiKey) throw new Error('Anthropic is not configured; add an API key in Settings.')
    return {
      mode: 'product',
      model,
      apiKeySlug: 'anthropic',
      apiKey,
      egress: ['api.anthropic.com:443'],
    }
  }
  if (model.startsWith('gpt')) {
    const apiKey = resolveApiKey('openai')
    if (!apiKey) throw new Error('OpenAI is not configured; add an API key in Settings.')
    const url = 'https://api.openai.com/v1'
    return { mode: 'openai-compatible', model, url, apiKey, egress: [originOf(url)] }
  }
  const acp = parseAcpModelSelection(model)
  if (acp) return resolveAcpHarness(model, acp.id)
  // Agent-backed selections are the common way to land here, and the reason is
  // worth saying out loud: an ACP, remote or plugin agent is a separate program
  // that authenticates as the user, from an OAuth login in `$HOME` or its own
  // vendor key. An unattended container holds neither by design
  // (`docs/plans/unattended-runs.md`, decision 3) and checks that it does not.
  if (isAgentBackedModel(model)) {
    throw new Error(
      `${model} runs as its own agent process signed in as you, and an unattended container is not given your credentials. Pick a model with an API key in Settings.`,
    )
  }
  throw new Error(`Container runs cannot resolve a provider for model "${model}"`)
}

/**
 * An ACP agent runs in the guest when the image carries its binary and the
 * user has its vendor's API key in Settings: the key is the run's one
 * credential, the desktop login never enters (decisions A1, A4, A6). Anything
 * else is refused with the same per-agent reason the picker shows.
 */
function resolveAcpHarness(model: string, agentId: string): ContainerProviderPlan {
  const agent = getAcpAgent(agentId)
  if (!agent) {
    throw new Error(
      `ACP agent "${agentId}" is not configured or is disabled; add it in Settings → ACP agents.`,
    )
  }
  const capable = containerAcpAgent(agent.id)
  const apiKey = capable ? resolveApiKey(capable.keySlug) : null
  const availability = containerAcpAvailability(
    agent.id,
    capable ? { [capable.keySlug]: Boolean(apiKey) } : {},
  )
  if (!capable || !apiKey || !availability.runnable) {
    throw new Error(
      `${agent.title} cannot run in a container: it ${availability.reason ?? 'is not available'}. The container is given one API key for the run, never your login.`,
    )
  }
  const domains = findAcpCatalogEntry(agent.id)?.sandbox?.allowedDomains ?? []
  return {
    mode: 'acp',
    model,
    harness: acpHarnessForContainer(agent, capable.keyEnv),
    apiKey,
    egress: domains.map((domain) => `${domain}:443`),
  }
}

/** Selections that run an external agent process rather than a provider client. */
function isAgentBackedModel(model: string): boolean {
  return (
    model.startsWith(ACP_MODEL_PREFIX) ||
    model.startsWith(REMOTE_AGENT_MODEL_PREFIX) ||
    model.startsWith(PLUGIN_MODEL_PREFIX)
  )
}
