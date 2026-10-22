import type { AgentRoleId } from '@copse/llm/agent-roles.ts'
import { parseDynamicModel, roleModelSelector } from '@copse/llm/dynamic-model.ts'
import { resolveIntellectModelId } from '@copse/llm/model-intellect.ts'
import { hostRoutedNamespace } from '@copse/llm/model-selection.ts'
import {
  REASONING_LEVELS,
  modelParameterSupport,
  type ModelParameters,
  type ReasoningLevel,
} from '@copse/llm/model-parameters.ts'
import { errorMessage } from '@shared/errors.ts'

/** Selection only: a resolved route grants neither execution nor spend authority. */
export interface WorkflowModelHost {
  roleModel: (role: AgentRoleId) => string
  expand: (selection: string, exclude: readonly string[]) => Promise<string>
  /** Reject unavailable, forbidden, or non-callable routes without making an inference call. */
  inspect: (model: string) => Promise<{ metered: boolean; parameters: ModelParameters }>
}

export interface WorkflowModelRequest {
  role: AgentRoleId
  /** Omit to use the role's assignment. Foreign agent aliases must be translated by their owner. */
  model?: string
  /** Ordered, explicit alternatives. There is no implicit fallback. */
  fallback?: readonly string[]
  reasoning?: ReasoningLevel
  maxReasoning?: ReasoningLevel
}

export interface WorkflowModelResolution {
  role: AgentRoleId
  requested: string
  model: string
  /** Null means identity is unknown; a different route alone does not prove diversity. */
  identity: string | null
  /** Conservative billing policy. Resolve never grants spend authority. */
  requiresSpendApproval: boolean
  parameters: ModelParameters
  fallback: Array<{ selection: string; reason: string }>
  reasoning: {
    requested: ReasoningLevel | null
    effective: ReasoningLevel | null
    status: 'default' | 'honoured' | 'adjusted' | 'unsupported'
    upstreamDecides: boolean
  }
}

async function expandWorkflowSelection(
  selection: string,
  host: WorkflowModelHost,
  exclude: readonly string[],
): Promise<string> {
  const visited = new Set<string>()
  let value = selection.trim()
  for (;;) {
    if (!value || visited.has(value))
      throw new Error(`Unassigned or cyclic workflow role: ${selection}`)
    visited.add(value)
    const selector = parseDynamicModel(value)
    if (selector?.kind !== 'role') return host.expand(value, exclude)
    // Never read the renderer-writable safety/reviewer assignments indirectly.
    if (selector.role === 'safety') throw new Error('Safety routing is not a workflow worker role.')
    value = host.roleModel(selector.role).trim()
  }
}

/** Resolves one bounded worker; its owner still enforces trust, approval, budget and cancellation. */
export async function resolveWorkflowModel(
  request: WorkflowModelRequest,
  signal: AbortSignal,
  host?: WorkflowModelHost,
  exclude: readonly string[] = [],
): Promise<WorkflowModelResolution> {
  signal.throwIfAborted()
  host ??= await desktopWorkflowModelHost()
  if (request.role === 'safety') throw new Error('Safety routing is not a workflow worker role.')
  let requested = request.model?.trim() ?? roleModelSelector(request.role)
  if (!requested) requested = roleModelSelector(request.role)
  const fallback: WorkflowModelResolution['fallback'] = []
  for (const selection of [requested, ...(request.fallback ?? [])]) {
    signal.throwIfAborted()
    try {
      const model = await expandWorkflowSelection(selection, host, exclude)
      signal.throwIfAborted()
      const namespace = hostRoutedNamespace(model)
      if (namespace)
        throw new Error(`${model} is not a provider-callable workflow route (${namespace}).`)
      const route = await host.inspect(model)
      signal.throwIfAborted()
      const support = modelParameterSupport(model)
      const desired = request.reasoning ?? route.parameters.reasoning ?? request.maxReasoning
      const ceiling = request.maxReasoning ?? desired
      const limit = ceiling === undefined ? -1 : REASONING_LEVELS.indexOf(ceiling)
      const wanted = desired === undefined ? -1 : REASONING_LEVELS.indexOf(desired)
      const effective = support.reasoning.findLast(
        (level) => REASONING_LEVELS.indexOf(level) <= Math.min(limit, wanted),
      )
      // A caller ceiling must reach the wire. An empty ladder means Copse cannot
      // send a level, not that the model does not reason, so it fails too.
      const unhonoured =
        request.maxReasoning ?? (support.reasoning.length > 0 ? desired : undefined)
      if (effective === undefined && unhonoured !== undefined)
        throw new Error(
          `${model} cannot honour the requested reasoning ceiling ${unhonoured}${support.reasoning.length ? '' : ' (it exposes no reasoning control)'}.`,
        )
      const { reasoning: _savedReasoning, ...parameters } = route.parameters
      return {
        role: request.role,
        requested,
        model,
        identity: resolveIntellectModelId(model),
        requiresSpendApproval: route.metered,
        parameters: { ...parameters, ...(effective === undefined ? {} : { reasoning: effective }) },
        fallback,
        reasoning: {
          requested: desired ?? null,
          effective: effective ?? null,
          status:
            desired === undefined
              ? 'default'
              : effective === undefined
                ? 'unsupported'
                : effective === desired
                  ? 'honoured'
                  : 'adjusted',
          upstreamDecides: support.upstreamDecides === true,
        },
      }
    } catch (error) {
      signal.throwIfAborted()
      fallback.push({ selection, reason: errorMessage(error) })
    }
  }
  throw new Error(
    `No workflow model resolved: ${fallback.map((entry) => `${entry.selection}: ${entry.reason}`).join('; ')}`,
  )
}

export interface WorkflowPanelResolution {
  members: WorkflowModelResolution[]
  diversity: 'cross-model' | 'same-model' | 'unknown'
  /** Always populated when independent cross-model review could not be established. */
  diversityNotice: string | null
}

/** Model selection for Copse Reviewer; this does not implement a second review engine. */
export async function resolveWorkflowPanelModels(
  requests: readonly WorkflowModelRequest[],
  signal: AbortSignal,
  host?: WorkflowModelHost,
): Promise<WorkflowPanelResolution> {
  signal.throwIfAborted()
  host ??= await desktopWorkflowModelHost()
  const members: WorkflowModelResolution[] = []
  for (const request of requests) {
    members.push(
      await resolveWorkflowModel(
        request,
        signal,
        host,
        members.map((member) => member.model),
      ),
    )
  }
  const identities = members.map((member) => member.identity)
  const sameRoute = new Set(members.map((member) => member.model)).size < members.length
  const known = identities.filter((identity) => identity !== null)
  const duplicate = sameRoute || new Set(known).size < known.length
  const diversity =
    duplicate || members.length < 2
      ? 'same-model'
      : known.length !== members.length
        ? 'unknown'
        : 'cross-model'
  return {
    members,
    diversity,
    diversityNotice:
      diversity === 'cross-model'
        ? null
        : diversity === 'same-model'
          ? 'Independent cross-model review is unavailable for the complete panel.'
          : 'Independent cross-model review is unconfirmed because model identity is unknown.',
  }
}

/** Existing Reviewer policy: automatic challengers may repeat the reviewer; pinned routes never change. */
export function resolveWorkflowReviewerModels(
  values: readonly string[],
  signal: AbortSignal,
  host?: WorkflowModelHost,
): Promise<WorkflowPanelResolution> {
  const first = values[0]
  return resolveWorkflowPanelModels(
    values.map((model, index) => {
      const selector = parseDynamicModel(model)
      return {
        role: 'reviewer',
        model,
        ...(index > 0 && selector && selector.kind !== 'role' && first
          ? { fallback: [first] }
          : {}),
      }
    }),
    signal,
    host,
  )
}

/** Lazy host binding keeps deterministic resolver tests free of Electron and credentials. */
async function desktopWorkflowModelHost(): Promise<WorkflowModelHost> {
  const [roles, settings, dynamic, providers, availability, frontier] = await Promise.all([
    import('./role-models.ts'),
    import('../storage/settings.ts'),
    import('./dynamic-model.ts'),
    import('./provider-selection.ts'),
    import('./workflow-route-availability.ts'),
    import('./best-value-model.ts'),
  ])
  return {
    roleModel: (role): string => {
      if (role === 'reviewer') return settings.getSettingTrimmed('reviewModel', '')
      if (role === 'safety') return ''
      const legacy = Object.entries(roles.ROUTED_SETTING_TO_ROLE).find(([, id]) => id === role)?.[0]
      if (!legacy) return roles.getRoleModels()[role]?.trim() ?? ''
      const value = roles.routedModelSetting(legacy)
      return hostRoutedNamespace(value) ? value : providers.normalizeRoleModelSelection(value)
    },
    expand: async (value, exclude): Promise<string> => {
      if (value === 'lm-studio') {
        const route = await providers.describeProvider(value)
        if (route.kind === 'lm-studio') return `lmstudio:${route.model}`
        throw new Error('The local model alias did not resolve to LM Studio.')
      }
      if (!parseDynamicModel(value)) return value
      if (process.env['COPSE_PANEL_MOCK_LLM'] === '1')
        return dynamic.resolveDynamicModelId(value, { callableOnly: true, exclude })
      const pool = await frontier.routableFrontierPoints({ callableOnly: true })
      if (!pool.length)
        throw new Error(
          `No available scored workflow route for ${value}. Choose a configured model explicitly.`,
        )
      const excludedIdentities = new Set(
        exclude.map(resolveIntellectModelId).filter((id) => id !== null),
      )
      const diverse = pool.filter(
        (point) =>
          !excludedIdentities.has(resolveIntellectModelId(frontier.toRoutableModelId(point)) ?? ''),
      )
      return dynamic.resolveDynamicModelId(value, {
        callableOnly: true,
        exclude,
        pool: diverse.length ? diverse : pool,
      })
    },
    inspect: async (model): ReturnType<WorkflowModelHost['inspect']> => {
      await availability.assertWorkflowRouteAvailable(model)
      return {
        metered: providers.isBillableModel(model),
        parameters: providers.resolveTurnParameters(model),
      }
    },
  }
}
