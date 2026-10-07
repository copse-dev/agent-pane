import {
  ACP_MODEL_PREFIX,
  PLUGIN_MODEL_PREFIX,
  REMOTE_AGENT_MODEL_PREFIX,
} from '@copse/llm/reserved-prefixes.ts'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { assertModelMakerAllowed } from './model-maker-policy.ts'
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import {
  containerAcpAgent,
  containerAcpAvailability,
  containerAcpLoginFiles,
} from '@shared/container-acp-agents.ts'
import type { ContainerModelVerdict } from '@shared/types/container-run.ts'
import { getAcpAgent } from '../acp/acp-agent-registry.ts'
import { normalizeHostname } from '@copse/llm/credential-url.ts'
import { withCredentialOutputRedaction } from '@copse/llm/credential-output-provider.ts'
import { HOST_LOCAL_ALIAS } from '../container-runtime/egress-rules.ts'
import { acpHarnessForContainer } from '../container-runtime/guest-acp-agent.ts'
import type { ThreadContainerAcpHarness } from '../container-runtime/thread-container.ts'
import { resolveApiKey } from '../storage/settings.ts'
import {
  providerEndpointUrl,
  providerNeedsKey,
  type ProviderDescription,
} from './provider-description.ts'
import {
  apiKeyForDescription,
  describeProvider,
  resolveTurnParameters,
  buildResolvedProvider,
  buildResolvedChatGptPlanProvider,
} from './provider-selection.ts'
import { parseChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import { getChatGptPlanService } from './chatgpt-plan-service.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { HOST_INFERENCE_TARGET } from '../container-runtime/host-inference-wire.ts'
import { resolveContextWindow } from './resolve-context-window.ts'

/** Built-in providers authenticate and infer on the host. External ACP agents remain in the guest. */
export type ContainerProviderPlan =
  | {
      mode: 'host-inference'
      model: string
      hostInference: (maxOutputTokens: number, runId: string) => Promise<LLMProvider>
      contextWindow: number
      apiKey: null
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
  // The alias is reserved: the guest treats it as loopback (it builds the
  // client with `hostLocalAlias`), which holds only while the one way to be
  // given it is this rewrite, with the broker told to dial the host's loopback.
  if (normalizeHostname(parsed.hostname) === HOST_LOCAL_ALIAS) {
    throw new Error(
      `${HOST_LOCAL_ALIAS} is reserved for a model server on this computer; a container run cannot use an endpoint that names it.`,
    )
  }
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
  threadId?: string
}

/**
 * The resolver's verdict on a model for the run dialog — decided by the
 * resolver itself, so the dialog's rows and a refused start can never disagree
 * about which key counts (stored in Settings, or in the environment). A row
 * that would run on the user's sign-in is reported as runnable with the
 * offer attached, so the dialog can show the opt-in for it.
 */
export async function explainContainerModel(model: string): Promise<ContainerModelVerdict> {
  try {
    await resolveContainerProvider(model)
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

export async function resolveContainerProvider(
  model: string,
  options: ContainerProviderOptions = {},
): Promise<ContainerProviderPlan> {
  assertModelMakerAllowed(model)
  const chatGpt = parseChatGptPlanModel(model)
  if (chatGpt) {
    const service = getChatGptPlanService()
    const params = resolveTurnParameters(model)
    const account = service.status().accounts.find((entry) => entry.clientId === chatGpt.clientId)
    if (!account?.connected || !account.planEnabled)
      throw new ContainerModelUnavailable(
        'Reconnect this ChatGPT account in Settings → Providers → OpenAI.',
        'ChatGPT sign-in required',
      )
    return {
      mode: 'host-inference',
      model,
      apiKey: null,
      egress: [HOST_INFERENCE_TARGET],
      contextWindow: await resolveContextWindow(model),
      hostInference: (maxOutputTokens, runId) =>
        Promise.resolve(
          buildResolvedChatGptPlanProvider(
            service,
            chatGpt,
            model,
            {
              ...params,
              maxOutputTokens: Math.min(maxOutputTokens, params.maxOutputTokens ?? maxOutputTokens),
            },
            `${options.threadId ?? 'container'}:${runId}`,
          ),
        ),
    }
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
  let description: ProviderDescription
  try {
    description = await describeProvider(model)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Container runs cannot resolve a provider for model "${model}": ${reason}`, {
      cause: error,
    })
  }
  const apiKey = apiKeyForDescription(description)
  if (apiKey === null && providerNeedsKey(description)) {
    throw new Error(`${providerLabel(description)} is not configured; add an API key in Settings.`)
  }
  // Validate reserved aliases, but never send a provider endpoint or key to the guest.
  guestFacingEndpoint(providerEndpointUrl(description))
  return {
    mode: 'host-inference',
    model,
    contextWindow: await resolveContextWindow(model),
    apiKey: null,
    egress: [HOST_INFERENCE_TARGET],
    hostInference: (maxOutputTokens, runId): Promise<LLMProvider> =>
      Promise.resolve(
        withCredentialOutputRedaction(
          buildResolvedProvider(
            {
              ...description,
              params: {
                ...description.params,
                maxOutputTokens: Math.min(
                  maxOutputTokens,
                  description.params.maxOutputTokens ?? maxOutputTokens,
                ),
              },
            },
            apiKey,
            `${options.threadId ?? 'container'}:${runId}`,
          ),
          apiKey ? [apiKey] : [],
        ),
      ),
  }
}

function providerLabel(description: ProviderDescription): string {
  switch (description.kind) {
    case 'anthropic':
      return 'Anthropic'
    case 'openai':
      return 'OpenAI'
    case 'openrouter':
      return 'OpenRouter'
    case 'openai-compatible':
      return description.label
    case 'lm-studio':
      return 'LM Studio'
  }
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
      `The coding agent "${agentId}" is not configured or is disabled. Add it in Settings → General → Providers.`,
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
