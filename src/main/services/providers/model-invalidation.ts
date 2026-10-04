import { AGENT_ROLES, type AgentRoleId } from '@copse/llm/agent-roles.ts'
import { firstPartyProviderOf } from '@copse/llm/model-families.ts'
import { getLocalModelCapability } from '@copse/llm/local-model-catalog.ts'
import { isDynamicModel } from '@copse/llm/dynamic-model.ts'
import { extraProviderSlugFromModel, isLocalBaseUrl } from '@copse/llm/extra-providers.ts'
import { parseChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import { parseAcpAgentConfigs, parseAcpModelSelection } from '@shared/acp.ts'
import { canonicalAcpAgentId } from '@shared/acp-known-agents.ts'
import { parseRemoteAgentModelSelection } from '@shared/remote-agent.ts'
import { parsePluginModelSelection } from '@shared/plugin-model.ts'
import { resolveLocalServerUrl } from '@shared/lm-studio-defaults.ts'
import { blockedModelMaker, parseBlockedModelMakers } from '@copse/llm/model-maker-block.ts'
import type {
  ModelInvalidation,
  ModelInvalidationReport,
  ModelSettingsTarget,
} from '@shared/model-invalidation.ts'
import { getSetting, getSettingTrimmed, resolveApiKey, updateSetting } from '../storage/settings.ts'
import { storageUpdate } from '../storage/storage.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import { providerKeyStatus } from './provider-key-status.ts'
import { fetchLmStudioModels, fetchLmStudioModelsCached } from './lm-studio-models.ts'
import { getChatGptPlanService } from './chatgpt-plan-service.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { pluginSettingsKey, readPluginSettings } from '../plugins/plugin-settings-read.ts'

interface SavedModel {
  target: ModelSettingsTarget
  label: string
  model: string
  role: AgentRoleId
  /** Legacy task-role fields stored bare local ids. */
  route?: string
  /** Compare inside the same storage queue as other writers. */
  replace: (expected: string, next: string, unchanged: () => boolean) => Promise<boolean>
}

export interface ModelInvalidationEnvironment {
  saved: () => SavedModel[]
  reason: (model: string) => Promise<string | null>
  verified?: (model: string) => Promise<boolean>
  localModels: (
    fresh?: boolean,
  ) => Promise<Array<{ id: string; local: boolean; embedding?: boolean }>>
  /** Private identity of provider configuration; never crosses IPC or logs. */
  revision: () => string
}

/** I/O is injected so races can be exercised without product-only test flags. */
export function createModelInvalidationService(env: ModelInvalidationEnvironment): {
  report: (threadModel?: string, freshLocal?: boolean) => Promise<ModelInvalidationReport>
  list: (threadModel?: string, freshLocal?: boolean) => Promise<ModelInvalidation[]>
  recover: (target: string, expected: string, fallback: string) => Promise<boolean>
} {
  const fallbackFor = (
    models: Awaited<ReturnType<ModelInvalidationEnvironment['localModels']>>,
    role: AgentRoleId,
  ): string | undefined => {
    const found = models.find(
      (model) =>
        model.local &&
        model.embedding !== true &&
        getLocalModelCapability(model.id)?.bestForRoles.includes(role),
    )
    return found ? `lmstudio:${found.id}` : undefined
  }

  async function report(
    threadModel?: string,
    freshLocal = false,
  ): Promise<ModelInvalidationReport> {
    const empty: ModelInvalidationReport = {
      evaluated: false,
      invalidations: [],
      selections: [],
      verifiedChoices: [],
    }
    const revision = env.revision()
    const candidates: Array<{
      target: ModelSettingsTarget | 'thread'
      label: string
      model: string
      role: AgentRoleId
      route?: string
    }> = env.saved()
    if (threadModel?.trim())
      candidates.unshift({
        target: 'thread',
        label: 'This chat',
        model: threadModel,
        role: 'coder',
      })
    const verifiedChoices: ModelInvalidationReport['verifiedChoices'] = []
    const invalid = await Promise.all(
      candidates.map(async (candidate) => {
        if (!candidate.model.trim() || isDynamicModel(candidate.model)) return null
        const reason = await env.reason(candidate.route ?? candidate.model)
        if (!reason && (await env.verified?.(candidate.route ?? candidate.model)))
          verifiedChoices.push({ target: candidate.target, model: candidate.model })
        return reason ? { ...candidate, reason } : null
      }),
    )
    if (env.revision() !== revision) return empty
    const models = invalid.some((entry) => entry !== null)
      ? await env.localModels(freshLocal).catch(() => [])
      : []
    if (env.revision() !== revision) return empty
    const latestSaved = env.saved()
    const selections: ModelInvalidationReport['selections'] = latestSaved.map(
      ({ target, model }) => ({ target, model }),
    )
    if (threadModel?.trim()) selections.unshift({ target: 'thread', model: threadModel })
    return {
      evaluated: true,
      selections,
      verifiedChoices: verifiedChoices.filter((choice) =>
        selections.some(
          (selection) => selection.target === choice.target && selection.model === choice.model,
        ),
      ),
      invalidations: invalid.flatMap((candidate) => {
        if (!candidate) return []
        if (
          candidate.target !== 'thread' &&
          !latestSaved.some(
            (entry) => entry.target === candidate.target && entry.model === candidate.model,
          )
        )
          return []
        const fallback = fallbackFor(models, candidate.role)
        return [
          {
            target: candidate.target,
            label: candidate.label,
            model: candidate.model,
            reason: candidate.reason,
            ...(fallback ? { fallback } : {}),
          },
        ]
      }),
    }
  }

  async function list(threadModel?: string, freshLocal = false): Promise<ModelInvalidation[]> {
    return (await report(threadModel, freshLocal)).invalidations
  }

  async function recover(target: string, expected: string, fallback: string): Promise<boolean> {
    const revision = env.revision()
    const candidate = env.saved().find((item) => item.target === target && item.model === expected)
    if (!candidate || !(await env.reason(candidate.route ?? expected))) return false
    const models = await env.localModels(true).catch(() => [])
    if (
      fallbackFor(
        models.filter((model) => `lmstudio:${model.id}` === fallback),
        candidate.role,
      ) !== fallback
    )
      return false
    if (env.revision() !== revision) return false
    return candidate.replace(
      expected,
      fallback,
      () =>
        env.revision() === revision &&
        env.saved().some((entry) => entry.target === target && entry.model === expected),
    )
  }
  return { list, report, recover }
}

const ORDINARY_MODELS: ReadonlyArray<{
  key: ModelSettingsTarget
  label: string
  role: AgentRoleId
  override?: AgentRoleId
}> = [
  { key: 'model', label: 'Chat default', role: 'coder' },
  { key: 'localDefaultModel', label: 'Coder', role: 'coder', override: 'coder' },
  { key: 'subagentModel', label: 'Research', role: 'research', override: 'research' },
  { key: 'smallTasksModel', label: 'Small tasks', role: 'small-tasks', override: 'small-tasks' },
  { key: 'orchestrationWorkerModel', label: 'Orchestration worker', role: 'coder' },
  { key: 'safetyModel', label: 'Instruct / safety model', role: 'safety' },
  { key: 'reviewModel', label: 'Post-turn review model', role: 'reviewer' },
]

function savedModels(): SavedModel[] {
  const roles = getSetting<Record<string, string>>('roleModels', {})
  const saved: SavedModel[] = ORDINARY_MODELS.flatMap(({ key, label, role, override }) => {
    // Only explicit saved values; an intentionally empty/automatic slot is not invalid.
    if (override && roles[override]?.trim()) return []
    const model = getSettingTrimmed(key)
    if (!model) return []
    const route =
      key !== 'model' && !model.includes(':') && !firstPartyProviderOf(model)
        ? `lmstudio:${model}`
        : model
    return [
      {
        target: key,
        label,
        model,
        role,
        route,
        replace: async (expected, next, unchanged): Promise<boolean> => {
          let replaced = false
          await updateSetting(key, '', (current) => {
            if (current.trim() !== expected || !unchanged()) return current
            replaced = true
            return next
          })
          return replaced
        },
      },
    ]
  })
  for (const role of AGENT_ROLES) {
    const model = roles[role.id]?.trim()
    if (!model) continue
    saved.push({
      target: `role:${role.id}`,
      label: role.label,
      model,
      role: role.id,
      route: !model.includes(':') && !firstPartyProviderOf(model) ? `lmstudio:${model}` : model,
      replace: async (expected, next, unchanged) => {
        let replaced = false
        await updateSetting<Record<string, string>>('roleModels', {}, (current) => {
          if (current[role.id]?.trim() !== expected || !unchanged()) return current
          replaced = true
          return { ...current, [role.id]: next }
        })
        return replaced
      },
    })
  }
  for (const plugin of getPluginService().list()) {
    if (!plugin.enabled) continue
    for (const field of plugin.settings) {
      if (field.kind !== 'model') continue
      // Advisor role assignment wins over the plugin field at runtime.
      if (field.id === 'advisorModel' && roles['advisor']?.trim()) continue
      const raw = readPluginSettings(plugin.id)[field.id]
      if (typeof raw !== 'string' || !raw.trim()) continue
      const model = raw.trim()
      saved.push({
        target: `plugin:${plugin.id}:${field.id}`,
        label: `${plugin.name}: ${field.title}`,
        model,
        role: field.id === 'advisorModel' ? 'advisor' : 'reviewer',
        replace: async (expected, next, unchanged) => {
          let replaced = false
          await storageUpdate(pluginSettingsKey(plugin.id), (rawBag) => {
            const current = readPluginSettings(plugin.id)
            if (current[field.id] !== expected || !unchanged()) return rawBag
            replaced = true
            return { ...current, [field.id]: next }
          })
          return replaced
        },
      })
    }
  }
  return saved
}

function localUrl(): string {
  return resolveLocalServerUrl(getSetting<string>('localServerUrl', ''), process.env)
}

/** Negative evidence is used only when the query succeeded or credentials were rejected. */
export async function modelInvalidationReason(model: string): Promise<string | null> {
  // Documented mock mode routes every selection in-process and uses no credentials.
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') return null
  const maker = blockedModelMaker(
    model,
    parseBlockedModelMakers(getSetting('blockedModelMakers', [])),
  )
  if (maker) return `${maker} models are blocked in Settings.`
  const acp = parseAcpModelSelection(model)
  if (acp) {
    const agent = parseAcpAgentConfigs(getSetting('registeredAcpAgents', [])).find(
      (entry) => canonicalAcpAgentId(entry.id) === canonicalAcpAgentId(acp.id),
    )
    if (!agent) return 'The device agent was removed.'
    if (!agent.enabled) return 'The device agent is disabled.'
    if (
      acp.model &&
      agent.modelsProbedAt !== undefined &&
      agent.availableModels &&
      !agent.availableModels.some((entry) => entry.value === acp.model)
    )
      return 'The device agent no longer advertises this model.'
    return null
  }
  const pluginRoute = parsePluginModelSelection(model)
  if (pluginRoute) {
    const plugin = getPluginService()
      .list()
      .find((entry) => entry.id === pluginRoute.pluginId)
    return plugin?.enabled &&
      plugin.contributions.modelRoutes.some((entry) => entry.id === pluginRoute.routeId)
      ? null
      : 'The plugin model route is no longer enabled.'
  }
  const chatgpt = parseChatGptPlanModel(model)
  if (chatgpt) {
    const service = getChatGptPlanService()
    const account = service.status().accounts.find((entry) => entry.clientId === chatgpt.clientId)
    if (!account?.connected || !account.planEnabled)
      return 'The ChatGPT account is disconnected or its plan permission was removed.'
    try {
      const catalog = await service.models(chatgpt.clientId)
      return catalog.models.some((entry) => entry.slug === chatgpt.model)
        ? null
        : 'This model is no longer offered by the ChatGPT account.'
    } catch {
      return null
    }
  }
  if (model === 'lm-studio') return null // Automatic first-loaded selection, not a pinned model.
  const extraSlug = extraProviderSlugFromModel(model)
  let provider: string | null =
    parseRemoteAgentModelSelection(model)?.provider ?? firstPartyProviderOf(model)
  if (model.startsWith('openrouter:')) provider = 'openrouter'
  if (extraSlug) {
    const extra = getResolvedExtraProviders().find((entry) => entry.id === extraSlug)
    if (!extra) return 'The selected model provider was removed.'
    if (extra.local) return null
    const status = await providerKeyStatus(extra.id)
    return status === 'missing'
      ? `${extra.label} has no configured API key.`
      : status === 'invalid'
        ? `${extra.label} rejected its configured API key.`
        : null
  }
  if (model.startsWith('lmstudio:')) {
    const id = model.replace(/^lmstudio:/, '')
    const catalog = await fetchLmStudioModelsCached(localUrl())
    return catalog.ok &&
      !catalog.models.some((entry) => entry.id === id && entry.embedding !== true)
      ? 'The configured local server no longer offers this chat model.'
      : null
  }
  if (!provider) return null
  const status = await providerKeyStatus(provider)
  return status === 'missing'
    ? `${provider} has no configured API key.`
    : status === 'invalid'
      ? `${provider} rejected its configured API key.`
      : null
}

/** Conclusive positive evidence used to re-arm warnings after a repaired route. */
async function modelRouteVerified(model: string): Promise<boolean> {
  if (await modelInvalidationReason(model)) return false
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1' || model === 'lm-studio') return true
  const acp = parseAcpModelSelection(model)
  if (acp) {
    const agent = parseAcpAgentConfigs(getSetting('registeredAcpAgents', [])).find(
      (entry) => canonicalAcpAgentId(entry.id) === canonicalAcpAgentId(acp.id),
    )
    return (
      agent?.enabled === true &&
      (!acp.model ||
        (agent.modelsProbedAt !== undefined &&
          agent.availableModels?.some((entry) => entry.value === acp.model) === true))
    )
  }
  const plugin = parsePluginModelSelection(model)
  if (plugin) return true // The reason check positively located its enabled route.
  const chatgpt = parseChatGptPlanModel(model)
  if (chatgpt) {
    try {
      return (await getChatGptPlanService().models(chatgpt.clientId)).models.some(
        (entry) => entry.slug === chatgpt.model,
      )
    } catch {
      return false
    }
  }
  if (model.startsWith('lmstudio:')) {
    const catalog = await fetchLmStudioModelsCached(localUrl())
    return (
      catalog.ok &&
      catalog.models.some(
        (entry) => entry.id === model.slice('lmstudio:'.length) && entry.embedding !== true,
      )
    )
  }
  const slug = extraProviderSlugFromModel(model)
  if (slug) {
    const extra = getResolvedExtraProviders().find((entry) => entry.id === slug)
    return (
      extra?.local === true ||
      (extra !== undefined && (await providerKeyStatus(extra.id)) === 'usable')
    )
  }
  const provider = model.startsWith('openrouter:')
    ? 'openrouter'
    : (parseRemoteAgentModelSelection(model)?.provider ?? firstPartyProviderOf(model))
  return provider !== null && (await providerKeyStatus(provider)) === 'usable'
}

function providerRevision(): string {
  const extras = getResolvedExtraProviders()
  return JSON.stringify([
    extras,
    [
      'anthropic',
      'openai',
      'cursor',
      'openrouter',
      'lmstudio',
      ...extras.map((entry) => entry.id),
    ].map((id) => resolveApiKey(id)),
    localUrl(),
    getSetting('registeredAcpAgents', []),
    getSetting('blockedModelMakers', []),
    getChatGptPlanService().status(),
    getPluginService()
      .list()
      .map((entry) => [entry.id, entry.enabled, entry.contributions.modelRoutes]),
  ])
}

export const modelInvalidationService = createModelInvalidationService({
  saved: savedModels,
  reason: modelInvalidationReason,
  verified: modelRouteVerified,
  localModels: async (fresh) => {
    const url = localUrl()
    if (!isLocalBaseUrl(url)) return []
    const result = await (fresh ? fetchLmStudioModels(url) : fetchLmStudioModelsCached(url))
    return result.ok ? result.models.map((entry) => ({ ...entry, local: isLocalBaseUrl(url) })) : []
  },
  revision: providerRevision,
})
