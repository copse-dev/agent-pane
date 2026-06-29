import type { ApiClient } from '../../../preload/api.d.ts'
import { PREFERRED_MODELS } from '@shared/preferred-models.ts'
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

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Model routing'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Choose which loaded local model handles each task. Leave a route on “auto” to use the first model the server reports.',
    ),
    routingField(
      'Default local model',
      localDefaultModel,
      'Fallback when a local model is selected in chat but not specified',
    ),
    routingField(
      'Exploration subagent model',
      subagentModel,
      'File exploration when the chat model is a cloud API model',
    ),
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

    populateLocalModelSelect(localDefaultModel, models, localModel ?? PREFERRED_MODELS[0]!.id)
    populateLocalModelSelect(
      subagentModel,
      models,
      subagent ?? '',
      '(auto — use default local model)',
    )
    populateLocalModelSelect(
      safetyModel,
      models,
      safety ?? PREFERRED_MODELS[2]!.id,
      '(auto — use default local model)',
    )
    populateLocalModelSelect(reviewModel, models, review ?? '', '(auto — use chat model)')
  }

  function readValues() {
    return {
      localDefaultModel: localDefaultModel.value.trim(),
      subagentModel: subagentModel.value.trim(),
      safetyModel: safetyModel.value.trim(),
      reviewModel: reviewModel.value.trim(),
    }
  }

  return { root: fieldset, refresh, readValues }
}
