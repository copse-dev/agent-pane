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

export interface ModelOptionsApi {
  settings: Pick<ApiClient['settings'], 'availableProviders' | 'extraProviders' | 'get'>
  openRouter: Pick<ApiClient['openRouter'], 'models'>
  remoteAgent: Pick<ApiClient['remoteAgent'], 'models'>
  lmStudio: Pick<ApiClient['lmStudio'], 'models'> &
    Partial<Pick<ApiClient['lmStudio'], 'modelInfo'>>
  packs?: Pick<ApiClient['packs'], 'list'>
}
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
  acpModelChoiceLabel,
  acpModelValue,
  acpModelVersionName,
  enabledClaudeAcpAgent,
  parseAcpAgentConfigs,
  parseAcpModel,
  parseAcpModelSelection,
} from '@shared/acp.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { PACK_MODEL_PREFIX, packModelValue, parsePackModelSelection } from '@shared/pack-model.ts'
import {
  BEST_VALUE_CHAT_MODEL,
  BEST_VALUE_CHAT_MODEL_LABEL,
  isBestValueChatModel,
} from '@shared/lm-studio-defaults.ts'
import { dynamicModelChoices, dynamicModelLabel } from '@copse/llm/dynamic-model.ts'
import { canonicalModelLabel, claudeModelIdFromLabel } from '@copse/llm/model-label.ts'

const ACP_GROUP = 'Agents on this device'

const OPENROUTER_GROUP = 'OpenRouter'

const CHAT_DEFAULT_GROUP = 'Chat default'

const KNOWN_TEXT_ONLY_MISTRAL_MODELS = [
  'mistral-small-latest',
  'open-mistral-nemo',
  'mistral-large-latest',
] as const

export interface ModelOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
  /** Image-input support when known; absent means the provider did not advertise it. */
  supportsImages?: boolean
}

export function modelDisplayLabel(model: string): string {
  if (isBestValueChatModel(model)) return BEST_VALUE_CHAT_MODEL_LABEL
  const dynamic = dynamicModelLabel(model)
  if (dynamic) return dynamic
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  const packModel = parsePackModelSelection(model)
  if (packModel) return packModel.routeId
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

/**
 * Intellect hint for a model an agent named itself. The same weights arrive
 * spelled every which way ("Opus 4.8", "Claude 4.6 Sonnet", a bare id), so each
 * form the agent gave us is tried against the measurement alias map first, and
 * only then the Anthropic id a plain family + version denotes — which is how a
 * spelling no alias covers still finds its measurement. Null when none resolve,
 * so an unmeasured model renders without a hint rather than with a guess.
 */
function agentModelIntellectHint(
  ...forms: ReadonlyArray<string | null | undefined>
): string | null {
  const named = forms.filter((form): form is string => Boolean(form))
  for (const form of named) {
    const hint = modelIntellectHint(form)
    if (hint) return hint
  }
  for (const form of named) {
    const id = claudeModelIdFromLabel(form)
    const hint = id === null ? null : modelIntellectHint(id)
    if (hint) return hint
  }
  return null
}

async function packModelOptions(
  api: ModelOptionsApi,
  includeAgentModels: boolean,
  current: string,
): Promise<ModelOption[]> {
  if (!includeAgentModels) return []
  try {
    const result = await api.packs?.list()
    if (!result) return []
    const currentSelection = parsePackModelSelection(current)
    return result.packs.flatMap((pack) =>
      pack.contributions.modelRoutes.flatMap((route) => {
        const selectedWhileDisabled =
          !pack.enabled &&
          currentSelection?.packId === pack.id &&
          currentSelection.routeId === route.id
        if (!pack.enabled && !selectedWhileDisabled) return []
        return [
          {
            value: packModelValue(pack.id, route.id),
            label: `${route.label}${selectedWhileDisabled ? ' (pack disabled)' : ''}`,
            group: route.group ?? `${pack.name} — personal pack`,
            ...(route.supportsImages !== undefined ? { supportsImages: route.supportsImages } : {}),
            ...(selectedWhileDisabled ? { disabled: true } : {}),
          },
        ]
      }),
    )
  } catch {
    return []
  }
}

// External ACP agents the user has configured. Only enabled agents are offered;
// a stale `acp:<id>` selection is surfaced below with the precise cause (agent
// removed, disabled, or selected model no longer advertised) rather than
// silently vanishing. The agents are fetched once by the caller (also used to
// decide the ACP-over-API ordering).
function acpAgentOptions(agents: readonly AcpAgentConfig[]): ModelOption[] {
  const options: ModelOption[] = []
  for (const agent of agents.filter((agent) => agent.enabled)) {
    // Each agent gets its own heading ("<Title> on this device"), so models list
    // bare underneath without a redundant "<Title> —" prefix.
    const group = acpGroupLabel(agent.title)
    const models = agent.availableModels ?? []
    if (models.length > 0) {
      // The agent exposes a model selector: list only its models (the bare
      // "agent default" entry is dropped — it's redundant and confusing).
      // ACP agents expose no token pricing, so the hint is intellect-only —
      // resolved via the measurement alias map (agent labels like "Opus 4.8").
      // Agents that label models by family alone keep the version in the
      // description, which is both what the row shows and what resolves.
      for (const model of models) {
        const label = acpModelChoiceLabel(model)
        const versioned = acpModelVersionName(model.description)
        const hint = agentModelIntellectHint(model.value, versioned, model.label, label)
        options.push({
          value: acpModelValue(agent.id, model.value),
          label: hint ? `${label} — ${hint}` : label,
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
  api: ModelOptionsApi,
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

  let liveModels: Array<{ id: string; name: string; supportsImages?: boolean }> = []
  try {
    liveModels = await api.openRouter.models()
  } catch {
    /* network error — fall through to custom/current only */
  }

  let customId = ''
  try {
    const value = await api.settings.get('openRouterModel')
    customId = typeof value === 'string' ? value.trim() : ''
  } catch {
    /* no custom model configured */
  }

  const seen = new Set<string>()
  const entries: ModelOption[] = []
  const add = (id: string, label: string, supportsImages?: boolean): void => {
    const value = toOpenRouterModel(id)
    if (!id || seen.has(value)) return
    seen.add(value)
    // Intellect-only hint (no catalog pricing for OpenRouter ids), matched via
    // the measurement alias map. `group` carries the ZDR/retention annotation.
    const hint = modelIntellectHint(id)
    entries.push({
      value,
      label: hint ? `${label} — ${hint}` : label,
      group,
      ...(supportsImages !== undefined ? { supportsImages } : {}),
    })
  }

  for (const model of liveModels) add(model.id, model.name || model.id, model.supportsImages)
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
    const supportsImages =
      provider.id === 'gemini'
        ? true
        : provider.id === 'deepseek' ||
            (provider.id === 'mistral' &&
              KNOWN_TEXT_ONLY_MISTRAL_MODELS.some((known) => known === id))
          ? false
          : undefined
    entries.push({
      value,
      label: hint ? `${label} — ${hint}` : label,
      group,
      ...(supportsImages !== undefined ? { supportsImages } : {}),
    })
  }

  for (const model of provider.models) add(model.id, model.id)
  if (extraProviderSlugFromModel(current) === provider.id) {
    add(extraProviderModelId(current), modelDisplayLabel(current))
  }
  return entries
}

async function remoteAgentOptions(
  api: ModelOptionsApi,
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
      // Cursor's catalog names Claude models its own way — a bare "Opus 5", or
      // "Claude 4.6 Sonnet (Thinking)" with the version ahead of the family.
      // Under a heading that names the agent rather than the vendor, that reads
      // as someone else's model, so it gets the same spelling as every other row.
      const vendorLabel = model.label || model.id
      const label = canonicalModelLabel(vendorLabel)
      // Intellect-only hint (remote agents are subscription-billed, no token price).
      const hint = agentModelIntellectHint(model.id, vendorLabel, label)
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
      add(current, canonicalModelLabel(currentSelection.model))
    }
  }

  if (isAvailable(REMOTE_AGENT_PROVIDER_ANTHROPIC)) {
    const baseGroup = remoteAgentGroupLabel(REMOTE_AGENT_PROVIDER_ANTHROPIC)
    // Claude Managed Agents bill against the Anthropic API key. When a Claude
    // device agent is configured, note that in the heading so the user sees the
    // on-device option (their own login) is the cheaper alternative.
    const group = preferAcpForClaude ? `${baseGroup} (billed to your API key)` : baseGroup
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
      add(current, canonicalModelLabel(currentSelection.model))
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
  /**
   * When true, include the Settings-only `auto:best-value` chat default.
   * The footer picker omits it — new chats resolve to a concrete model instead.
   */
  includeBestValue?: boolean
}

export async function fetchModelOptions(
  api: ModelOptionsApi,
  current: string,
  opts: FetchModelOptionsOpts = {},
): Promise<ModelOption[]> {
  const options: ModelOption[] = []
  if (opts.includeBestValue === true) {
    options.push({
      value: BEST_VALUE_CHAT_MODEL,
      label: `${BEST_VALUE_CHAT_MODEL_LABEL} — auto from plan / price frontier`,
      group: CHAT_DEFAULT_GROUP,
    })
  }
  // ACP agents are hidden on SSH workspaces UNLESS the user opted into remote ACP
  // over SSH, in which case they spawn on the remote host (docs/plans/acp-over-ssh.md).
  const isSshWorkspace = opts.sshWorkspace === true
  const acpOverSsh = isSshWorkspace && (await api.settings.get('acpOverSshEnabled')) === true
  const sshWorkspace = isSshWorkspace && !acpOverSsh
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
    options.push({
      value,
      label: hint ? `${label} — ${hint}` : label,
      group: cloudGroup,
      supportsImages: true,
    })
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
      acpAgents = parseAcpAgentConfigs(await api.settings.get('registeredAcpAgents'))
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
    options.push(...(await packModelOptions(api, includeAgentModels, current)))
  }

  // Local models: only listed when a local server is reachable and exposes some.
  const lmGroup = 'Local models'
  let models: Array<{ id: string; supportsImages?: boolean }>
  try {
    const modelInfo = api.lmStudio.modelInfo ? await api.lmStudio.modelInfo() : []
    models = modelInfo.length > 0 ? modelInfo : (await api.lmStudio.models()).map((id) => ({ id }))
  } catch {
    models = []
  }
  for (const model of models) {
    const { id } = model
    const hint = [localModelRoleHint(id), localModelIntellectHint(id)]
      .filter((part): part is string => part !== null)
      .join(' · ')
    options.push({
      value: `lmstudio:${id}`,
      label: hint ? `${id} — ${hint}` : id,
      group: lmGroup,
      ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
    })
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
      const selection = parseAcpModelSelection(current)
      const configuredAgent = selection
        ? acpAgents.find((agent) => agent.id === selection.id)
        : undefined
      const configuredButUnlisted = configuredAgent?.enabled === true
      const stale: ModelOption = {
        value: current,
        label: sshWorkspace
          ? `${modelDisplayLabel(current)} (unavailable on SSH)`
          : configuredButUnlisted
            ? `${configuredAgent.title} — ${selection?.model ?? 'agent default'} (not currently advertised)`
            : configuredAgent
              ? `${configuredAgent.title} (disabled)`
              : `${modelDisplayLabel(current)} (not configured)`,
        group: configuredAgent ? acpGroupLabel(configuredAgent.title) : ACP_GROUP,
      }
      if (sshWorkspace) stale.disabled = true
      options.push(stale)
    } else if (includeAgentModels && current.startsWith(PACK_MODEL_PREFIX)) {
      options.push({
        value: current,
        label: `${modelDisplayLabel(current)} (pack disabled)`,
        group: 'Personal packs',
        disabled: true,
      })
    } else {
      options.push({ value: current, label: `${current} (no key)` })
    }
  }

  // Only when nothing at all is configured (no cloud key, no provider, no local
  // server — and no Settings best-value row) do we surface a guiding message.
  const concreteCount = options.filter((o) => !isBestValueChatModel(o.value)).length
  if (concreteCount === 0) {
    options.push({
      value: '',
      label: 'No models available — add a provider or API key in Settings',
      disabled: true,
    })
  }

  return options
}

function autoModelOption(label: string): ModelOption {
  return { value: '', label }
}

/** Options for lightweight/background prompts, including their automatic route. */
export async function fetchSmallTasksModelOptions(
  api: ModelOptionsApi,
  current: string,
): Promise<ModelOption[]> {
  return [
    autoModelOption('(auto — prefer local, fall back to chat model)'),
    ...(await fetchModelOptions(api, current)),
  ]
}

/**
 * Options for an in-process task role. Remote/ACP agents own full sessions and
 * therefore cannot be selected for research, review, or safety roles.
 */
export async function fetchRoleModelOptions(
  api: ModelOptionsApi,
  current: string,
  autoLabel = '(auto — prefer on-device)',
): Promise<ModelOption[]> {
  return [
    autoModelOption(autoLabel),
    ...(await fetchModelOptions(api, current, { includeAgentModels: false })),
  ]
}

/** Local-only routing options used by onboarding before cloud setup is complete. */
export function localModelOptions(
  models: readonly string[],
  autoLabel = '(auto — first loaded model)',
): ModelOption[] {
  return [autoModelOption(autoLabel), ...models.map((id) => ({ value: id, label: id }))]
}

/** Group heading for a pinned model kept selectable in a dynamic-only picker. */
const PINNED_GROUP = 'Currently pinned'

/**
 * The option list for a picker that selects *how* to choose a model rather than
 * which one — every pack-owned model setting and the Experimental worker model.
 *
 * These features run unattended, often long after the picker was last opened: a
 * pinned id there quietly rots as keys, plans, and local models change, and the
 * user has no reason to revisit it. A rule keeps meaning what it said.
 *
 * A `current` value that is *not* a selector (a choice made before this, or a
 * hand-edited settings file) is kept as its own row rather than dropped. Silently
 * showing a different selection than the one that will actually run is worse than
 * one extra row, and choosing any dynamic option retires it.
 */
export function dynamicModelOptions(current: string, autoLabel?: string): ModelOption[] {
  const options: ModelOption[] = dynamicModelChoices().map((choice) => ({
    value: choice.value,
    label: `${choice.label} — ${choice.description}`,
    group: choice.group,
  }))
  // A field whose blank value means something ("reviewer A follows the chat
  // model") needs that state selectable, or the picker would show a rule the
  // feature is not using. Same `''` convention as the role/small-task pickers.
  if (autoLabel !== undefined) options.unshift(autoModelOption(autoLabel))
  const pinned = current.trim()
  if (pinned && !options.some((option) => option.value === pinned)) {
    options.unshift({
      value: pinned,
      label: `${modelDisplayLabel(pinned)} (pinned)`,
      group: PINNED_GROUP,
    })
  }
  return options
}

/** {@link dynamicModelOptions} in the async shape every picker's `loadOptions` wants. */
export function fetchDynamicModelOptions(
  current: string,
  autoLabel?: string,
): Promise<ModelOption[]> {
  return Promise.resolve(dynamicModelOptions(current, autoLabel))
}
