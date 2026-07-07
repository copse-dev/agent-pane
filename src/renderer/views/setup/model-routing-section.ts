import type { ApiClient } from '../../../preload/api.d.ts'
import { PREFERRED_MODELS } from '@shared/preferred-models.ts'
import { at } from '@shared/array-utils.ts'
import { populateLocalModelSelect } from '../model-options.ts'
import { el } from '../../dom/helpers.ts'

export interface ModelRoutingSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
  readValues: () => {
    localDefaultModel: string
    subagentModel: string
    safetyModel: string
    reviewModel: string
  }
}

function routingField(label: string, control: HTMLElement, hint: string): HTMLDivElement {
  return el(
    'div',
    { class: 'setup-field' },
    el('span', { class: 'setup-field-label' }, label),
    control,
    el('span', { class: 'field-hint' }, hint),
  )
}

export function createModelRoutingSection(api: ApiClient): ModelRoutingSection {
  const localDefaultModel = el('select', { name: 'localDefaultModel' })
  const subagentModel = el('select', { name: 'subagentModel' })
  const safetyModel = el('select', { name: 'safetyModel' })
  const reviewModel = el('select', { name: 'reviewModel' })

  // Roles are the simple front: pick the local model for each named job. The
  // finer-grained routes that most users never touch live under "Advanced" so
  // the default view stays short. Leave any route on “auto” to use the first
  // loaded model. (These cover local routing; cloud roles are a follow-up.)
  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Local model roles'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Assign a local model to each role. Features that share a role reuse the same model, so you set it once here.',
    ),
    routingField('Coder', localDefaultModel, 'Main local model for coding and general chat'),
    routingField(
      'Research',
      subagentModel,
      'File exploration when the chat model is a cloud API model',
    ),
    el(
      'details',
      { class: 'routing-advanced' },
      el('summary', {}, 'Advanced routes'),
      routingField(
        'Instruct / safety model',
        safetyModel,
        'Classifies shell commands when the OS sandbox is off',
      ),
      routingField(
        'Post-turn review model',
        reviewModel,
        'Reviews the diff after an editing turn (auto reuses the chat model)',
      ),
    ),
  )

  async function refresh(): Promise<void> {
    let models: string[]
    try {
      models = await api.lmStudio.models()
    } catch {
      models = []
    }

    const localModel = (await api.settings.get('localDefaultModel')) as string | undefined
    const subagent = (await api.settings.get('subagentModel')) as string | undefined
    const safety = (await api.settings.get('safetyModel')) as string | undefined
    const review = (await api.settings.get('reviewModel')) as string | undefined

    populateLocalModelSelect(localDefaultModel, models, localModel ?? at(PREFERRED_MODELS, 0).id)
    populateLocalModelSelect(
      subagentModel,
      models,
      subagent ?? '',
      '(auto — use default local model)',
    )
    populateLocalModelSelect(
      safetyModel,
      models,
      safety ?? at(PREFERRED_MODELS, 2).id,
      '(auto — use default local model)',
    )
    populateLocalModelSelect(reviewModel, models, review ?? '', '(auto — use chat model)')
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

  return { root: fieldset, refresh, readValues }
}
