import {
  ACP_MODEL_PREFIX,
  PLUGIN_MODEL_PREFIX,
  REMOTE_AGENT_MODEL_PREFIX,
} from '@copse/llm/reserved-prefixes.ts'
import { parseAcpModelSelection } from '@shared/acp.ts'
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import {
  containerAcpAgent,
  containerAcpAvailability,
  containerAcpLoginFiles,
} from '@shared/container-acp-agents.ts'
import type { ContainerModelVerdict } from '@shared/types/container-run.ts'
import { getAcpAgent } from '../acp/acp-agent-registry.ts'
import { acpHarnessForContainer } from '../container-runtime/guest-acp-agent.ts'
import type { ThreadContainerAcpHarness } from '../container-runtime/thread-container.ts'
import { resolveApiKey } from '../storage/settings.ts'
import {
  providerEndpointUrl,
  providerNeedsKey,
  type ProviderDescription,
} from './provider-description.ts'
import { apiKeyForDescription, describeProvider } from './provider-selection.ts'
import { resolveContextWindow } from './resolve-context-window.ts'

/**
 * How a container run reaches the model for a given product model id
 * (`docs/plans/thread-in-container.md`). The guest has no network; the host
 * brokers exactly one origin for the model, so this must name it up front.
 *
 * Two shapes:
 * - `provider`: the desktop's own resolution of the model (`describeProvider`:
 *   protocol, endpoint, tuned parameters, privacy and transport settings),
 *   carried into the guest, which builds the same client from it. The one
 *   difference is the endpoint's name when it is a server on the desktop's
 *   loopback, which the guest cannot reach by that address.
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
      mode: 'provider'
      /** The selection as the user made it, for the record and the usage ledger. */
      model: string
      /** The desktop's resolution, as the guest should dial it; see {@link guestFacingEndpoint}. */
      provider: ProviderDescription
      /** What the desktop would trim history against for this model. */
      contextWindow: number
      apiKey: string | null
      egress: string[]
      /** Guest-facing host → where the broker dials it, for a host-local endpoint. */
      egressResolve?: Record<string, string>
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
  const facing = guestFacingEndpoint(providerEndpointUrl(description))
  return {
    mode: 'provider',
    model,
    provider: forGuest(description, facing.url),
    contextWindow: await resolveContextWindow(model),
    apiKey,
    egress: facing.egress,
    ...(facing.egressResolve ? { egressResolve: facing.egressResolve } : {}),
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
 * The description as the guest builds from it. LM Studio's own transport is a
 * WebSocket the guest proxy cannot carry, so in the guest LM Studio is what
 * it also is: an OpenAI-compatible endpoint. An endpoint on the desktop's
 * loopback is renamed to the alias the broker resolves.
 */
function forGuest(description: ProviderDescription, url: string): ProviderDescription {
  switch (description.kind) {
    case 'lm-studio':
      return {
        kind: 'openai-compatible',
        model: description.model,
        apiKeySlug: description.apiKeySlug,
        url,
        label: 'LM Studio',
        local: true,
        includeUsage: true,
        params: description.params,
      }
    case 'openai-compatible':
      return { ...description, url }
    default:
      return description
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
