import type { ApiClient } from '../../../preload/api.d.ts'
import { PREFERRED_MODELS } from '@shared/preferred-models.ts'
import { populateLocalModelSelect } from '../model-options.ts'
import { el } from '../../dom/helpers.ts'

export interface ModelRoutingSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
  readValues: () => {
    lmStudioModel: string
    lmStudioSmallTasksModel: string
    lmStudioSubagentModel: string
    lmStudioSafetyModel: string
  }
}

export function createModelRoutingSection(api: ApiClient): ModelRoutingSection {
  const lmStudioModel = el('select', { name: 'lmStudioModel' }) as HTMLSelectElement
  const lmStudioSmallTasksModel = el('select', {
    name: 'lmStudioSmallTasksModel',
  }) as HTMLSelectElement
  const lmStudioSubagentModel = el('select', {
    name: 'lmStudioSubagentModel',
  }) as HTMLSelectElement
  const lmStudioSafetyModel = el('select', { name: 'lmStudioSafetyModel' }) as HTMLSelectElement

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Model routing'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Choose which loaded model handles each task. Leave a route on “auto” to use the first model the server reports.',
    ),
    el(
      'label',
      {},
      'Default local model',
      lmStudioModel,
      el(
        'span',
        { class: 'field-hint' },
        'Fallback when a local model is selected in chat but not specified',
      ),
    ),
    el(
      'label',
      {},
      'Small tasks model',
      lmStudioSmallTasksModel,
      el('span', { class: 'field-hint' }, 'Thread title generation and other lightweight prompts'),
    ),
    el(
      'label',
      {},
      'Exploration subagent model',
      lmStudioSubagentModel,
      el(
        'span',
        { class: 'field-hint' },
        'File exploration when the chat model is a cloud API model',
      ),
    ),
    el(
      'label',
      {},
      'Instruct / safety model',
      lmStudioSafetyModel,
      el('span', { class: 'field-hint' }, 'Classifies shell commands when the OS sandbox is off'),
    ),
  ) as HTMLFieldSetElement

  async function refresh(): Promise<void> {
    let models: string[] = []
    try {
      models = await api.lmStudio.models()
    } catch {
      models = []
    }

    const lmModel = (await api.settings.get('lmStudioModel')) as string | undefined
    const lmSmall = (await api.settings.get('lmStudioSmallTasksModel')) as string | undefined
    const lmSubagent = (await api.settings.get('lmStudioSubagentModel')) as string | undefined
    const lmSafety = (await api.settings.get('lmStudioSafetyModel')) as string | undefined

    populateLocalModelSelect(lmStudioModel, models, lmModel ?? PREFERRED_MODELS[0]!.id)
    populateLocalModelSelect(
      lmStudioSmallTasksModel,
      models,
      lmSmall ?? PREFERRED_MODELS[1]!.id,
      '(auto — use default local model)',
    )
    populateLocalModelSelect(
      lmStudioSubagentModel,
      models,
      lmSubagent ?? '',
      '(auto — use default local model)',
    )
    populateLocalModelSelect(
      lmStudioSafetyModel,
      models,
      lmSafety ?? PREFERRED_MODELS[2]!.id,
      '(auto — use default local model)',
    )
  }

  function readValues() {
    return {
      lmStudioModel: lmStudioModel.value.trim(),
      lmStudioSmallTasksModel: lmStudioSmallTasksModel.value.trim(),
      lmStudioSubagentModel: lmStudioSubagentModel.value.trim(),
      lmStudioSafetyModel: lmStudioSafetyModel.value.trim(),
    }
  }

  return { root: fieldset, refresh, readValues }
}
