import type { ApiClient } from '../../preload/api.d.ts'
import { CLOUD_MODELS, cloudModelDisplayLabel } from '@copse/llm/model-catalog.ts'
import { localModelRoleHint } from '@copse/llm/local-model-catalog.ts'
import {
  cloudModelIntellectHint,
  localModelIntellectHint,
  modelIntellectHint,
} from '@copse/llm/intellect-hints.ts'
import {
  isOpenRouterModel,
  openRouterDisplayLabel,
  openRouterModelId,
  toOpenRouterModel,
} from '@copse/llm/openrouter.ts'
import {
  extraProviderDisplayLabel,
  extraProviderModelId,
  extraProviderSlugFromModel,
  isExtraProviderModel,
  toExtraProviderModel,
  type ExtraProvider,
} from '@copse/llm/extra-providers.ts'
import {
  dataPolicyForProvider,
  openRouterDataPolicy,
  pickerPrivacyNote,
} from '@copse/llm/data-policies.ts'

type AvailableProviders = Awaited<ReturnType<ApiClient['settings']['availableProviders']>>
import {
  MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT,
  REMOTE_AGENT_MODEL_PREFIX,
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
  REMOTE_AGENT_PROVIDER_CURSOR,
  parseRemoteAgentModelSelection,
  remoteAgentDisplayLabel,
  remoteAgentGroupLabel,
  remoteAgentModelValue,
} from '@shared/remote-agent.ts'
import {
  ACP_MODEL_PREFIX,
  acpGroupLabel,
  acpModelValue,
  enabledClaudeAcpAgent,
  parseAcpModel,
} from '@shared/acp.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { clear } from '../dom/helpers.ts'

const ACP_GROUP = 'ACP agents'

const OPENROUTER_GROUP = 'OpenRouter'

export interface ModelOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}

export function modelDisplayLabel(model: string): string {
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  if (isOpenRouterModel(model)) return openRouterDisplayLabel(model)
  if (isExtraProviderModel(model)) return extraProviderDisplayLabel(model)
  if (parseRemoteAgentModelSelection(model)) {
    return remoteAgentDisplayLabel(model)
  }
  // Without the configured-agents list to resolve a title, fall back to the id.
  const acpId = parseAcpModel(model)
  if (acpId) return acpId
  return cloudModelDisplayLabel(model)
}

// External ACP agents the user has configured. Only enabled agents are offered;
// a stale `acp:<id>` selection for a removed/disabled agent is surfaced via the
// "(not configured)" fallback below rather than silently vanishing. The agents
// are fetched once by the caller (also used to decide the ACP-over-API ordering).
function acpAgentOptions(agents: readonly AcpAgentConfig[]): ModelOption[] {
  const options: ModelOption[] = []
  for (const agent of agents.filter((agent) => agent.enabled)) {
    // Each agent gets its own heading ("<Title> Client (ACP)"), so models list
    // bare underneath without a redundant "<Title> —" prefix.
    const group = acpGroupLabel(agent.title)
    const models = agent.availableModels ?? []
    if (models.length > 0) {
      // The agent exposes a model selector: list only its models (the bare
      // "agent default" entry is dropped — it's redundant and confusing).
      // ACP agents expose no token pricing, so the hint is intellect-only —
      // resolved via the measurement alias map (agent labels like "Opus 4.8").
      for (const model of models) {
        const hint = modelIntellectHint(model.value) ?? modelIntellectHint(model.label)
        options.push({
          value: acpModelValue(agent.id, model.value),
          label: hint ? `${model.label} — ${hint}` : model.label,
          group,
        })
      }
    } else {
      // No discovered models (never detected, or the agent has a fixed model):
      // fall back to a single entry that routes to the agent's own default.
      options.push({ value: acpModelValue(agent.id), label: agent.title, group })
    }
  }
  return options
}

// OpenRouter tool-capable models fetched live from its catalog (free-only when
// openRouterFreeMode is on), plus any custom id the user saved (or currently
// has selected — which may be a paid id).
// When no key is configured we contribute nothing (the provider is hidden from
// the picker rather than shown as a disabled "add a key" row).
async function openRouterOptions(
  api: ApiClient,
  available: boolean,
  current: string,
): Promise<ModelOption[]> {
  if (!available) return []

  // Annotate the group heading when ZDR-only routing is off, so the picker
  // shows that upstream retention/training policies then apply per model.
  let group = OPENROUTER_GROUP
  try {
    const zdrOnly = (await api.settings.get('openRouterZdrOnly')) !== false
    const allowTraining = (await api.settings.get('openRouterAllowTraining')) === true
    const note = pickerPrivacyNote(openRouterDataPolicy(zdrOnly, allowTraining))
    group = note ? `${OPENROUTER_GROUP} — ${note}` : `${OPENROUTER_GROUP} (ZDR routing)`
  } catch {
    /* keep the plain heading */
  }

  let liveModels: Array<{ id: string; name: string }> = []
  try {
    liveModels = await api.openRouter.models()
  } catch {
    /* network error — fall through to custom/current only */
  }

  let customId = ''
  try {
    customId = (((await api.settings.get('openRouterModel')) as string | null) ?? '').trim()
  } catch {
    /* no custom model configured */
  }

  const seen = new Set<string>()
  const entries: ModelOption[] = []
  const add = (id: string, label: string): void => {
    const value = toOpenRouterModel(id)
    if (!id || seen.has(value)) return
    seen.add(value)
    // Intellect-only hint (no catalog pricing for OpenRouter ids), matched via
    // the measurement alias map. `group` carries the ZDR/retention annotation.
    const hint = modelIntellectHint(id)
    entries.push({ value, label: hint ? `${label} — ${hint}` : label, group })
  }

  for (const model of liveModels) add(model.id, model.name || model.id)
  if (customId) add(customId, `${customId} (custom)`)
  if (isOpenRouterModel(current)) add(openRouterModelId(current), modelDisplayLabel(current))

  if (entries.length === 0) {
    let freeOnly = false
    try {
      freeOnly = (await api.settings.get('openRouterFreeMode')) === true
    } catch {
      /* default: show all models */
    }
    return [
      {
        value: '',
        label: freeOnly ? 'No free tool-capable models found' : 'No tool-capable models found',
        group,
        disabled: true,
      },
    ]
  }
  return entries
}

// Curated, tool-capable models for a direct cloud provider (Mistral, Gemini,
// DeepSeek, or a user-added one). Unlike OpenRouter there is no live catalog, so
// the shortlist comes from the registry; the currently-selected id is kept
// selectable even if it isn't in the shortlist. An unconfigured provider (no key)
// contributes nothing — it's hidden from the picker rather than shown as a hint.
function extraProviderOptions(
  provider: ExtraProvider,
  available: boolean,
  current: string,
): ModelOption[] {
  if (!available) return []

  // Flag providers that may train on inputs (Gemini free tier, Mistral free
  // plans, DeepSeek) or whose retention depends on a routed partner (Hugging
  // Face) directly in the group heading. Local servers never carry a note.
  const note = provider.local ? null : pickerPrivacyNote(dataPolicyForProvider(provider))
  const group = note ? `${provider.label} — ${note}` : provider.label

  const seen = new Set<string>()
  const entries: ModelOption[] = []
  const add = (id: string, label: string): void => {
    const value = toExtraProviderModel(provider.id, id)
    if (!id || seen.has(value)) return
    seen.add(value)
    // Intellect-only hint (extra-provider ids carry no catalog pricing),
    // matched via the measurement alias map. `group` carries the data-policy
    // annotation (may-train / retention-varies).
    const hint = modelIntellectHint(id)
    entries.push({ value, label: hint ? `${label} — ${hint}` : label, group })
  }

  for (const model of provider.models) add(model.id, model.label ?? model.id)
  if (extraProviderSlugFromModel(current) === provider.id) {
    add(extraProviderModelId(current), modelDisplayLabel(current))
  }
  return entries
}

async function remoteAgentOptions(
  api: ApiClient,
  isAvailable: (provider: string) => boolean,
  current: string,
  // When the user has an enabled Claude ACP agent, flag the Claude Cloud Agent
  // group as API-billed so the ACP alternative (their own `claude` login) reads
  // as the preferred option. Ordering is handled by the caller.
  preferAcpForClaude = false,
): Promise<ModelOption[]> {
  const options: ModelOption[] = []

  if (isAvailable(REMOTE_AGENT_PROVIDER_CURSOR)) {
    const group = remoteAgentGroupLabel(REMOTE_AGENT_PROVIDER_CURSOR)
    let liveModels: Array<{ id: string; label: string }> = []
    try {
      liveModels = await api.remoteAgent.models()
    } catch {
      /* network error — fall through to default / current only */
    }

    const seen = new Set<string>()
    const add = (value: string, label: string): void => {
      if (seen.has(value)) return
      seen.add(value)
      options.push({ value, label, group })
    }

    // Account default (omit model on Create Agent) — always first when the key
    // is configured, even when the live catalog is empty.
    add(remoteAgentModelValue(REMOTE_AGENT_PROVIDER_CURSOR), 'Default')
    for (const model of liveModels) {
      const label = model.label || model.id
      // Intellect-only hint (remote agents are subscription-billed, no token
      // price), matched via the measurement alias map on id or label.
      const hint = modelIntellectHint(model.id) ?? modelIntellectHint(label)
      add(
        remoteAgentModelValue(REMOTE_AGENT_PROVIDER_CURSOR, model.id),
        hint ? `${label} — ${hint}` : label,
      )
    }
    const currentSelection = parseRemoteAgentModelSelection(current)
    if (
      currentSelection?.provider === REMOTE_AGENT_PROVIDER_CURSOR &&
      currentSelection.model &&
      !seen.has(current)
    ) {
      add(current, currentSelection.model)
    }
  }

  if (isAvailable(REMOTE_AGENT_PROVIDER_ANTHROPIC)) {
    const baseGroup = remoteAgentGroupLabel(REMOTE_AGENT_PROVIDER_ANTHROPIC)
    // Claude Managed Agents bill against the Anthropic API key. When a Claude ACP
    // agent is configured, note that in the heading so the user sees the ACP
    // option (their own login) is the cheaper alternative.
    const group = preferAcpForClaude ? `${baseGroup} — API-billed (ACP available)` : baseGroup
    const seen = new Set<string>()
    const add = (value: string, label: string): void => {
      if (seen.has(value)) return
      seen.add(value)
      options.push({ value, label, group })
    }
    // Same Claude ids as the Cloud models group, with the shared friendly
    // labels. Intellect-only hint (subscription-billed, like Cursor).
    for (const id of MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT) {
      const label = cloudModelDisplayLabel(id)
      const hint = modelIntellectHint(id)
      add(
        remoteAgentModelValue(REMOTE_AGENT_PROVIDER_ANTHROPIC, id),
        hint ? `${label} — ${hint}` : label,
      )
    }
    const currentSelection = parseRemoteAgentModelSelection(current)
    if (
      currentSelection?.provider === REMOTE_AGENT_PROVIDER_ANTHROPIC &&
      currentSelection.model &&
      !seen.has(current)
    ) {
      add(current, currentSelection.model)
    }
    // Keep a pre-multi-model bare selection selectable until the user switches.
    if (current === remoteAgentModelValue(REMOTE_AGENT_PROVIDER_ANTHROPIC) && !seen.has(current)) {
      add(current, remoteAgentGroupLabel(REMOTE_AGENT_PROVIDER_ANTHROPIC))
    }
  }

  return options
}

export interface FetchModelOptionsOpts {
  /**
   * When true, omit ACP agents from the picker (they run as local stdio processes
   * and are not supported on SSH workspaces). A stale `acp:*` selection stays
   * visible but disabled.
   */
  sshWorkspace?: boolean
  /**
   * Remote / ACP agents run whole chat sessions rather than one-shot model
   * roles. Role pickers set this false so they only offer provider-backed
   * models that can execute a task in-process.
   */
  includeAgentModels?: boolean
}

export async function fetchModelOptions(
  api: ApiClient,
  current: string,
  opts: FetchModelOptionsOpts = {},
): Promise<ModelOption[]> {
  const options: ModelOption[] = []
  const sshWorkspace = opts.sshWorkspace === true
  const includeAgentModels = opts.includeAgentModels !== false

  let available: AvailableProviders = {}
  try {
    available = await api.settings.availableProviders()
  } catch {
    /* keep defaults */
  }
  // When availability is unknown (e.g. the query failed), default to hiding the
  // option rather than offering a provider that may reject the key at run time.
  const isAvailable = (provider: string): boolean => available[provider] ?? false
  // Hosted Anthropic/OpenAI models. Grouped so they get a heading like every
  // other section (otherwise they'd be the only headingless block at the top).
  const cloudGroup = 'Cloud models'
  for (const [value, label, provider] of CLOUD_MODELS) {
    if (!isAvailable(provider)) continue
    const hint = cloudModelIntellectHint(value)
    options.push({ value, label: hint ? `${label} — ${hint}` : label, group: cloudGroup })
  }

  options.push(...(await openRouterOptions(api, isAvailable('openrouter'), current)))

  let extraProviders: ExtraProvider[] = []
  try {
    extraProviders = await api.settings.extraProviders()
  } catch {
    /* no extra providers available */
  }
  for (const provider of extraProviders) {
    options.push(...extraProviderOptions(provider, isAvailable(provider.id), current))
  }

  // Configured ACP agents, fetched once: used both to build their picker rows
  // and to decide whether to prefer ACP over the API-billed Claude Cloud agent.
  // ACP agents are local stdio processes, so they are never offered on an SSH
  // workspace — leave the list empty there (a stale `acp:*` selection is still
  // surfaced as disabled by the fallback below).
  let acpAgents: AcpAgentConfig[] = []
  if (includeAgentModels && !sshWorkspace) {
    try {
      acpAgents = ((await api.settings.get('registeredAcpAgents')) as AcpAgentConfig[] | null) ?? []
    } catch {
      /* none configured */
    }
  }
  // An enabled Claude ACP agent drives Claude through the user's own `claude`
  // login; prefer it over the API-billed Claude Cloud Agent by listing ACP first
  // and flagging the Cloud Agent as API-billed.
  const preferAcpForClaude = enabledClaudeAcpAgent(acpAgents) !== undefined

  // Remote agents (Cursor Cloud, Claude Cloud) expand into per-provider groups
  // with concrete model rows — same pattern as ACP agents. When ACP is preferred
  // its agents lead; otherwise the remote agents keep their original position
  // ahead of ACP.
  if (includeAgentModels) {
    const remote = await remoteAgentOptions(api, isAvailable, current, preferAcpForClaude)
    const acp = acpAgentOptions(acpAgents)
    options.push(...(preferAcpForClaude ? [...acp, ...remote] : [...remote, ...acp]))
  }

  // Local models: only listed when a local server is reachable and exposes some.
  const lmGroup = 'Local models'
  let models: string[]
  try {
    models = await api.lmStudio.models()
  } catch {
    models = []
  }
  for (const id of models) {
    const hint = [localModelRoleHint(id), localModelIntellectHint(id)]
      .filter((part): part is string => part !== null)
      .join(' · ')
    options.push({ value: `lmstudio:${id}`, label: hint ? `${id} — ${hint}` : id, group: lmGroup })
  }

  if (current && !options.some((o) => o.value === current)) {
    if (current.startsWith('lmstudio:')) {
      options.push({
        value: current,
        label: `${current.slice('lmstudio:'.length)} (offline)`,
        group: lmGroup,
      })
    } else if (includeAgentModels && current.startsWith(REMOTE_AGENT_MODEL_PREFIX)) {
      const selection = parseRemoteAgentModelSelection(current)
      options.push({
        value: current,
        label: `${modelDisplayLabel(current)} (no valid key)`,
        group: selection ? remoteAgentGroupLabel(selection.provider) : 'Remote agents',
      })
    } else if (includeAgentModels && current.startsWith(ACP_MODEL_PREFIX)) {
      const stale: ModelOption = {
        value: current,
        label: sshWorkspace
          ? `${modelDisplayLabel(current)} (unavailable on SSH)`
          : `${modelDisplayLabel(current)} (not configured)`,
        group: ACP_GROUP,
      }
      if (sshWorkspace) stale.disabled = true
      options.push(stale)
    } else {
      options.push({ value: current, label: `${current} (no key)` })
    }
  }

  // Only when nothing at all is configured (no cloud key, no provider, no local
  // server) do we surface a single guiding message instead of an empty picker.
  if (options.length === 0) {
    options.push({
      value: '',
      label: 'No models available — add a provider or API key in Settings',
      disabled: true,
    })
  }

  return options
}

function opt(value: string, label: string, disabled = false): HTMLOptionElement {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  o.disabled = disabled
  return o
}

// Fill a <select> with the cloud models plus a local optgroup of the models the
// configured local server exposes (value `lmstudio:<id>`). Keeps the
// `current` value selectable even if the server is offline.
export async function populateModelSelect(
  select: HTMLSelectElement,
  api: ApiClient,
  current: string,
): Promise<void> {
  clear(select)
  const options = await fetchModelOptions(api, current)
  let lastGroup: string | undefined
  let groupEl: HTMLOptGroupElement | null = null
  for (const item of options) {
    if (item.group !== lastGroup) {
      lastGroup = item.group
      if (item.group) {
        groupEl = document.createElement('optgroup')
        groupEl.label = item.group
        select.append(groupEl)
      } else {
        groupEl = null
      }
    }
    const node = opt(item.value, item.label, item.disabled)
    if (groupEl) groupEl.append(node)
    else select.append(node)
  }
  select.value = current
}

/** Fill a <select> with local model ids for routing settings (blank = auto). */
export function populateLocalModelSelect(
  select: HTMLSelectElement,
  models: string[],
  current: string,
  autoLabel = '(auto — first loaded model)',
): void {
  clear(select)
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = autoLabel
  select.append(auto)
  for (const id of models) {
    const o = document.createElement('option')
    o.value = id
    o.textContent = id
    select.append(o)
  }
  select.value = current
}

/** Model picker for small tasks — cloud, local, or auto (empty value). */
export async function populateSmallTasksModelSelect(
  select: HTMLSelectElement,
  api: ApiClient,
  current: string,
): Promise<void> {
  clear(select)
  select.append(opt('', '(auto — prefer local, fall back to chat model)'))
  const options = await fetchModelOptions(api, current)
  let lastGroup: string | undefined
  let groupEl: HTMLOptGroupElement | null = null
  for (const item of options) {
    if (item.group !== lastGroup) {
      lastGroup = item.group
      if (item.group) {
        groupEl = document.createElement('optgroup')
        groupEl.label = item.group
        select.append(groupEl)
      } else {
        groupEl = null
      }
    }
    const node = opt(item.value, item.label, item.disabled)
    if (groupEl) groupEl.append(node)
    else select.append(node)
  }
  select.value = current
}

/**
 * Model picker for a task role. Unlike the chat picker, this deliberately omits
 * remote / ACP agents: those own an entire chat session and cannot act as an
 * in-process research, review, or safety model. The blank choice keeps the
 * role's on-device default.
 */
export async function populateRoleModelSelect(
  select: HTMLSelectElement,
  api: ApiClient,
  current: string,
  autoLabel = '(auto — prefer on-device)',
): Promise<void> {
  clear(select)
  select.append(opt('', autoLabel))
  const options = await fetchModelOptions(api, current, { includeAgentModels: false })
  let lastGroup: string | undefined
  let groupEl: HTMLOptGroupElement | null = null
  for (const item of options) {
    if (item.group !== lastGroup) {
      lastGroup = item.group
      if (item.group) {
        groupEl = document.createElement('optgroup')
        groupEl.label = item.group
        select.append(groupEl)
      } else {
        groupEl = null
      }
    }
    const node = opt(item.value, item.label, item.disabled)
    if (groupEl) groupEl.append(node)
    else select.append(node)
  }
  select.value = current
}
