import type { ApiClient } from '../../../preload/api.d.ts'
import { PREFERRED_MODELS } from '@shared/preferred-models.ts'
import { at } from '@shared/array-utils.ts'
import { lmStudioChatModelValue } from '@shared/lm-studio-defaults.ts'
import { populateLocalModelSelect, populateRoleModelSelect } from '../model-options.ts'
import { el } from '../../dom/helpers.ts'
import { optionalString } from '@shared/unknown-value.ts'

export interface ModelRoutingSection {
  root: HTMLElement
  refresh: () => Promise<void>
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

function routingField(label: string, control: HTMLElement, hint: string): HTMLLabelElement {
  return el(
    'label',
    { class: 'setup-field' },
    el('span', { class: 'setup-field-label' }, label),
    control,
    el('span', { class: 'field-hint' }, hint),
  )
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
      el('summary', {}, 'Advanced routes'),
      routingField(
        'Instruct / safety model',
        safetyModel,
        'Classifies shell commands and screens terminal reads. A cloud choice sends that screening content to its provider.',
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

  async function refresh(): Promise<void> {
    const localModel = optionalString(await api.settings.get('localDefaultModel'))
    const subagent = optionalString(await api.settings.get('subagentModel'))
    const safety = optionalString(await api.settings.get('safetyModel'))
    const review = optionalString(await api.settings.get('reviewModel'))
    const roleModels =
      ((await api.settings.get('roleModels')) as Record<string, string> | undefined) ?? {}

    if (modelScope === 'all') {
      const coder = roleModels['coder'] ?? localModel
      const research = roleModels['research'] ?? subagent
      await Promise.all([
        populateRoleModelSelect(
          localDefaultModel,
          api,
          coder
            ? canonicalRoleSelection(coder)
            : lmStudioChatModelValue(at(PREFERRED_MODELS, 0).id),
        ),
        populateRoleModelSelect(subagentModel, api, canonicalRoleSelection(research ?? '')),
        populateRoleModelSelect(
          safetyModel,
          api,
          safety
            ? canonicalRoleSelection(safety)
            : lmStudioChatModelValue(at(PREFERRED_MODELS, 2).id),
        ),
        populateRoleModelSelect(reviewModel, api, canonicalRoleSelection(review ?? '')),
      ])
      return
    }

    let models: string[]
    try {
      models = await api.lmStudio.models()
    } catch {
      models = []
    }
    populateLocalModelSelect(
      localDefaultModel,
      models,
      localModel?.replace(/^lmstudio:/, '') ?? at(PREFERRED_MODELS, 0).id,
    )
    populateLocalModelSelect(
      subagentModel,
      models,
      subagent?.replace(/^lmstudio:/, '') ?? '',
      '(auto — use default local model)',
    )
    populateLocalModelSelect(
      safetyModel,
      models,
      safety?.replace(/^lmstudio:/, '') ?? at(PREFERRED_MODELS, 2).id,
    )
    populateLocalModelSelect(
      reviewModel,
      models,
      review?.replace(/^lmstudio:/, '') ?? '',
      '(auto — prefer on-device)',
    )
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

  return { root, refresh, readValues }
}

/** Legacy role settings stored bare LM Studio ids; provider-backed values are canonical. */
function canonicalRoleSelection(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.includes(':') || trimmed.startsWith('claude-') || trimmed.startsWith('gpt-')) {
    return trimmed
  }
  return lmStudioChatModelValue(trimmed)
}
