import type { ApiClient } from '../../../preload/api.d.ts'
import { firstPartyProviderOf } from '@copse/llm/model-capabilities.ts'
import { PREFERRED_MODELS } from '@shared/preferred-models.ts'
import { at } from '@shared/array-utils.ts'
import { DEFAULT_SAFETY_MODEL, lmStudioChatModelValue } from '@shared/lm-studio-defaults.ts'
import { fetchRoleModelOptions, localModelOptions, type ModelOption } from '../model-options.ts'
import { mountModelSelectPicker } from '../model-picker.ts'
import { el } from '../../dom/helpers.ts'
import { disclosureSummary } from '../../dom/disclosure-summary.ts'
import { optionalString, stringRecordOrEmpty } from '@shared/unknown-value.ts'
import { uiField } from '../../ui/index.ts'
import { AGENT_ROLES } from '@copse/llm/agent-roles.ts'
import { qsRequired } from '../../dom/helpers.ts'

/** Structural subset of a Settings snapshot, also usable during onboarding. */
export interface ModelRoutingSnapshot {
  localDefaultModel?: string | undefined
  subagentModel?: string | undefined
  safetyModel?: string | undefined
  reviewModel?: string | undefined
  roleModels?: Record<string, string> | undefined
}

export interface ModelRoutingSection {
  root: HTMLElement
  /** Discard cancelled role edits immediately, without waiting for provider reads. */
  reset: () => void
  refresh: (snapshot?: ModelRoutingSnapshot) => Promise<void>
  /** Only user-edited additional roles; parent Save merges these atomically. */
  readRoleModels: () => Record<string, string> | undefined
  readValues: () => {
    localDefaultModel: string
    subagentModel: string
    safetyModel: string
    reviewModel: string
  }
}

export interface ModelRoutingSectionOptions {
  /** Settings offers every provider model; onboarding intentionally stays local-only. */
  modelScope?: 'all' | 'local'
}

function routingField(label: string, control: HTMLElement, hint: string): HTMLElement {
  return uiField({ label, control, hint })
}

export function createModelRoutingSection(
  api: ApiClient,
  options: ModelRoutingSectionOptions = {},
): ModelRoutingSection {
  const modelScope = options.modelScope ?? 'local'
  const localDefaultModel = el('select', { name: 'localDefaultModel' })
  const subagentModel = el('select', { name: 'subagentModel' })
  const safetyModel = el('select', { name: 'safetyModel' })
  const reviewModel = el('select', { name: 'reviewModel' })

  // Roles are the simple front: pick one model for each named job. Settings
  // offers every in-process provider model, while onboarding remains scoped to
  // the local server it is configuring.
  const fields = el(
    'div',
    { class: 'model-role-fields' },
    routingField('Coder', localDefaultModel, 'Default model for coding-oriented background work'),
    routingField('Research', subagentModel, 'File exploration and search subagents'),
    el(
      'details',
      { class: 'routing-advanced' },
      disclosureSummary('Advanced routes'),
      routingField(
        'Instruct / safety model',
        safetyModel,
        'Classifies shell commands and screens terminal reads. Defaults to the best model on this device that clears a minimum intelligence score, and to the cheapest cloud route that clears it when no local model does — a cloud choice sends that screening content to its provider. A classifier chosen under Classifiers → Safety screening replaces it.',
      ),
      routingField('Post-turn review model', reviewModel, 'Reviews the diff after an editing turn'),
    ),
  )
  if (modelScope === 'all') {
    fields.prepend(
      el('h4', { class: 'model-role-heading' }, 'Task roles'),
      el(
        'p',
        { class: 'settings-fieldset-desc' },
        'Use any connected cloud or on-device model. Auto choices prefer on-device models.',
      ),
    )
  }

  const root =
    modelScope === 'local'
      ? el(
          'fieldset',
          {},
          el('legend', {}, 'Local model roles'),
          el(
            'p',
            { class: 'settings-fieldset-desc' },
            'Assign a local model to each role. Features that share a role reuse the same model, so you set it once here.',
          ),
          fields,
        )
      : fields

  let availableLocalModels: string[] = []
  type OptionLoader = (current: string) => Promise<ModelOption[]>
  const pickerOptions: Record<'coder' | 'research' | 'safety' | 'review', OptionLoader> =
    modelScope === 'all'
      ? {
          coder: (current: string): Promise<ModelOption[]> => fetchRoleModelOptions(api, current),
          research: (current: string): Promise<ModelOption[]> =>
            fetchRoleModelOptions(api, current),
          safety: (current: string): Promise<ModelOption[]> => fetchRoleModelOptions(api, current),
          review: (current: string): Promise<ModelOption[]> =>
            fetchRoleModelOptions(api, current, '(auto: prefer on-device)'),
        }
      : {
          // `current` is forwarded so a role pinned to a model the server does
          // not have keeps a row of its own, flagged as not available, instead
          // of silently rendering as the auto option.
          coder: (current: string): Promise<ModelOption[]> =>
            Promise.resolve(
              localModelOptions(availableLocalModels, '(auto — first loaded model)', current),
            ),
          research: (current: string): Promise<ModelOption[]> =>
            Promise.resolve(
              localModelOptions(availableLocalModels, '(auto: use default local model)', current),
            ),
          safety: (current: string): Promise<ModelOption[]> =>
            Promise.resolve(
              localModelOptions(availableLocalModels, '(auto — first loaded model)', current),
            ),
          review: (current: string): Promise<ModelOption[]> =>
            Promise.resolve(
              localModelOptions(availableLocalModels, '(auto: prefer on-device)', current),
            ),
        }
  const modelPickers = {
    coder: mountModelSelectPicker(localDefaultModel, {
      loadOptions: pickerOptions.coder,
      ariaLabel: 'Coder model',
      loadOnMount: false,
    }),
    research: mountModelSelectPicker(subagentModel, {
      loadOptions: pickerOptions.research,
      ariaLabel: 'Research model',
      loadOnMount: false,
    }),
    safety: mountModelSelectPicker(safetyModel, {
      loadOptions: pickerOptions.safety,
      ariaLabel: 'Instruct and safety model',
      loadOnMount: false,
    }),
    review: mountModelSelectPicker(reviewModel, {
      loadOptions: pickerOptions.review,
      ariaLabel: 'Post-turn review model',
      loadOnMount: false,
    }),
  }

  const fieldTargets: Record<string, string> = {
    coder: 'localDefaultModel',
    research: 'subagentModel',
    safety: 'safetyModel',
    review: 'reviewModel',
  }
  for (const [key, picker] of Object.entries(modelPickers)) {
    const target = fieldTargets[key]
    if (target)
      qsRequired(picker.root, '.model-picker-trigger').setAttribute(
        'data-model-setting-target',
        target,
      )
  }
  let pendingRoles: Record<string, string> = {}
  const additionalRoles =
    modelScope === 'all'
      ? AGENT_ROLES.filter((role) => !['coder', 'research', 'small-tasks'].includes(role.id)).map(
          (role) => {
            const select = el('select', { name: `role:${role.id}` })
            const field = routingField(
              role.label,
              select,
              `${role.description}. An empty choice inherits the automatic role default.`,
            )
            select.addEventListener('change', () => {
              pendingRoles[role.id] = select.value
            })
            const picker = mountModelSelectPicker(select, {
              loadOptions: (current: string): Promise<ModelOption[]> =>
                fetchRoleModelOptions(api, current, '(automatic role default)'),
              ariaLabel: `${role.label} role model`,
              loadOnMount: false,
            })
            qsRequired(picker.root, '.model-picker-trigger').setAttribute(
              'data-model-setting-target',
              `role:${role.id}`,
            )
            return { role, field, picker }
          },
        )
      : []
  if (additionalRoles.length) {
    fields.append(
      el(
        'details',
        { class: 'routing-additional-roles' },
        disclosureSummary('Additional model roles'),
        el(
          'p',
          { class: 'settings-fieldset-desc' },
          'These assignments are used by “By role” model rules. The dedicated safety and post-turn review routes above remain separate.',
        ),
        ...additionalRoles.map((entry) => entry.field),
      ),
    )
  }

  function reset(): void {
    pendingRoles = {}
  }

  async function refresh(snapshot?: ModelRoutingSnapshot): Promise<void> {
    reset()
    const localModel = optionalString(
      snapshot ? snapshot.localDefaultModel : await api.settings.get('localDefaultModel'),
    )
    const subagent = optionalString(
      snapshot ? snapshot.subagentModel : await api.settings.get('subagentModel'),
    )
    const safety = optionalString(
      snapshot ? snapshot.safetyModel : await api.settings.get('safetyModel'),
    )
    const review = optionalString(
      snapshot ? snapshot.reviewModel : await api.settings.get('reviewModel'),
    )
    const roleModels = stringRecordOrEmpty(
      snapshot ? snapshot.roleModels : await api.settings.get('roleModels'),
    )
    if (modelScope === 'all') {
      const coder = roleModels['coder'] ?? localModel
      const research = roleModels['research'] ?? subagent
      await Promise.all([
        modelPickers.coder.refresh(
          coder
            ? canonicalRoleSelection(coder)
            : lmStudioChatModelValue(at(PREFERRED_MODELS, 0).id),
        ),
        modelPickers.research.refresh(canonicalRoleSelection(research ?? '')),
        // Unset means the *rule*, not the model we recommend downloading —
        // showing a concrete local id here would misreport what actually runs.
        modelPickers.safety.refresh(safety ? canonicalRoleSelection(safety) : DEFAULT_SAFETY_MODEL),
        modelPickers.review.refresh(canonicalRoleSelection(review ?? '')),
        ...additionalRoles.map((entry) =>
          entry.picker.refresh(canonicalRoleSelection(roleModels[entry.role.id] ?? '')),
        ),
      ])
      return
    }

    let models: string[]
    try {
      models = await api.lmStudio.models()
    } catch {
      models = []
    }
    availableLocalModels = models
    await Promise.all([
      modelPickers.coder.refresh(
        localModel?.replace(/^lmstudio:/, '') ?? at(PREFERRED_MODELS, 0).id,
      ),
      modelPickers.research.refresh(subagent?.replace(/^lmstudio:/, '') ?? ''),
      modelPickers.safety.refresh(safety?.replace(/^lmstudio:/, '') ?? DEFAULT_SAFETY_MODEL),
      modelPickers.review.refresh(review?.replace(/^lmstudio:/, '') ?? ''),
    ])
  }

  function readValues(): {
    localDefaultModel: string
    subagentModel: string
    safetyModel: string
    reviewModel: string
  } {
    return {
      localDefaultModel: localDefaultModel.value.trim(),
      subagentModel: subagentModel.value.trim(),
      safetyModel: safetyModel.value.trim(),
      reviewModel: reviewModel.value.trim(),
    }
  }

  return {
    root,
    reset,
    refresh,
    readValues,
    readRoleModels: (): Record<string, string> | undefined =>
      Object.keys(pendingRoles).length ? { ...pendingRoles } : undefined,
  }
}

/** Legacy role settings stored bare LM Studio ids; provider-backed values are canonical. */
function canonicalRoleSelection(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.includes(':') || firstPartyProviderOf(trimmed) !== null) {
    return trimmed
  }
  return lmStudioChatModelValue(trimmed)
}
