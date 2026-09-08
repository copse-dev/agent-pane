import { OPENROUTER_BASE_URL, isOpenRouterModel, openRouterModelId } from '@copse/llm/openrouter.ts'
import {
  ACP_MODEL_PREFIX,
  PLUGIN_MODEL_PREFIX,
  REMOTE_AGENT_MODEL_PREFIX,
} from '@copse/llm/reserved-prefixes.ts'
import { extraProviderForModel, extraProviderModelId } from '@copse/llm/extra-providers.ts'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import {
  containerAcpAgent,
  containerAcpAvailability,
  containerAcpLoginFiles,
} from '@shared/container-acp-agents.ts'
import type { ContainerModelVerdict } from '@shared/types/container-run.ts'
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
      /** The URL as the guest should dial it; see {@link guestFacingEndpoint}. */
      url: string
      apiKey: string | null
      egress: string[]
      /** Guest-facing host → where the broker dials it, for a host-local endpoint. */
      egressResolve?: Record<string, string>
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
      /** Null when the run carries the user's sign-in instead (`harness.login`). */
      apiKey: string | null
      egress: string[]
    }

function originOf(url: string): string {
  const parsed = new URL(url)
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return `${parsed.hostname}:${String(port)}`
}

/** The name the guest dials a host-local endpoint by; the broker resolves it to the host. */
export const HOST_LOCAL_ALIAS = 'model.copse.internal'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * An OpenAI-compatible endpoint as the guest should dial it. A server on the
 * desktop's loopback (LM Studio at `http://127.0.0.1:1234/v1`, say) cannot be
 * named by that address in the guest: loopback bypasses the guest proxy by
 * design, so the guest would dial its own — empty — loopback and the run
 * would fail on the first request. Such a URL is rewritten to a name only
 * the guest knows, admitted by the allowlist under that name, and resolved
 * by the broker back to the host's loopback at the same port.
 */
export function guestFacingEndpoint(url: string): {
  url: string
  egress: string[]
  egressResolve?: Record<string, string>
} {
  const parsed = new URL(url)
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return { url, egress: [originOf(url)] }
  const dialHost = parsed.hostname === '::1' || parsed.hostname === '[::1]' ? '::1' : '127.0.0.1'
  parsed.hostname = HOST_LOCAL_ALIAS
  const guestUrl = parsed.toString()
  return {
    url: guestUrl,
    egress: [originOf(guestUrl)],
    egressResolve: { [HOST_LOCAL_ALIAS]: dialHost },
  }
}

/**
 * A model the container cannot run, with the short reason the dialog puts on
 * the row beside the full sentence a failed start shows.
 */
export class ContainerModelUnavailable extends Error {
  readonly reason: string
  /** Set when the agent would run on the user's sign-in if they opted in. */
  readonly loginOffered: { agentTitle: string } | null

  constructor(message: string, reason: string, loginOffered: { agentTitle: string } | null = null) {
    super(message)
    this.name = 'ContainerModelUnavailable'
    this.reason = reason
    this.loginOffered = loginOffered
  }
}

/** How the caller wants an ACP agent authenticated when it has no vendor key. */
export interface ContainerProviderOptions {
  /** Carry the agent's desktop sign-in into the run (decision A1′); never the default. */
  useAgentLogin?: boolean
}

/**
 * The resolver's verdict on a model for the run dialog — decided by the
 * resolver itself, so the dialog's rows and a refused start can never disagree
 * about which key counts (stored in Settings, or in the environment). A row
 * that would run on the user's sign-in is reported as runnable with the
 * offer attached, so the dialog can show the opt-in for it.
 */
export function explainContainerModel(model: string): ContainerModelVerdict {
  try {
    resolveContainerProvider(model)
    return { reason: null }
  } catch (error) {
    if (error instanceof ContainerModelUnavailable) {
      return error.loginOffered
        ? { reason: null, loginOffered: error.loginOffered }
        : { reason: error.reason }
    }
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}

export function resolveContainerProvider(
  model: string,
  options: ContainerProviderOptions = {},
): ContainerProviderPlan {
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = resolveLocalServerUrl(getSetting<string>('localServerUrl', ''), process.env)
    const configured = model.startsWith('lmstudio:') ? model.slice('lmstudio:'.length) : ''
    const id = configured || LM_STUDIO_MODEL_IDS.chat
    return {
      mode: 'openai-compatible',
      model: id,
      apiKey: getLmStudioApiKey() || null,
      ...guestFacingEndpoint(url),
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
      apiKey,
      ...guestFacingEndpoint(extra.baseUrl),
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
  if (acp) return resolveAcpHarness(model, acp.id, options)
  // Agent-backed selections are the common way to land here, and the reason is
  // worth saying out loud: an ACP, remote or plugin agent is a separate program
  // that authenticates as the user, from an OAuth login in `$HOME` or its own
  // vendor key. An unattended container holds neither by design
  // (`docs/plans/unattended-runs.md`, decision 3) and checks that it does not.
  if (isAgentBackedModel(model)) {
    throw new ContainerModelUnavailable(
      `${model} runs as its own agent process signed in as you, and an unattended container is not given your credentials. Pick a model with an API key in Settings.`,
      'not available in a container',
    )
  }
  throw new Error(`Container runs cannot resolve a provider for model "${model}"`)
}

/**
 * An ACP agent runs in the guest when the image carries its binary and the
 * user has its vendor's API key in Settings: the key is the run's one
 * credential (decisions A1, A4, A6). Without a key, an agent whose sign-in
 * lives in files may run on that sign-in when the user opts in for the run
 * (A1′). Anything else is refused with the same per-agent reason the picker
 * shows.
 */
function resolveAcpHarness(
  model: string,
  agentId: string,
  options: ContainerProviderOptions,
): ContainerProviderPlan {
  const agent = getAcpAgent(agentId)
  if (!agent) {
    throw new ContainerModelUnavailable(
      `ACP agent "${agentId}" is not configured or is disabled; add it in Settings → ACP agents.`,
      'not configured in Settings',
    )
  }
  const capable = containerAcpAgent(agent.id)
  const apiKey = capable ? resolveApiKey(capable.keySlug) : null
  const availability = containerAcpAvailability(
    agent.id,
    capable ? { [capable.keySlug]: Boolean(apiKey) } : {},
    { useLogin: options.useAgentLogin === true },
  )
  if (!capable || !availability.runnable) {
    throw new ContainerModelUnavailable(
      `${agent.title} cannot run in a container: it ${availability.reason ?? 'is not available'}. The container is given one credential for the run: an API key, or, if you opt in, your sign-in copied in.`,
      availability.reason ?? 'not available in a container',
      availability.loginOffered ? { agentTitle: agent.title } : null,
    )
  }
  const domains = findAcpCatalogEntry(agent.id)?.sandbox?.allowedDomains ?? []
  const harness = acpHarnessForContainer(agent, capable.keyEnv)
  const loginFiles = availability.credential === 'login' ? containerAcpLoginFiles(agent.id) : null
  return {
    mode: 'acp',
    model,
    harness: loginFiles ? { ...harness, login: { files: loginFiles } } : harness,
    apiKey: availability.credential === 'key' ? apiKey : null,
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
