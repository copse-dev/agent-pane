import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import { qsRequired, el } from '../../dom/helpers.ts'
import { MODEL_MAKERS, parseBlockedModelMakers } from '@copse/llm/model-maker-block.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { BEST_VALUE_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import { stringRecordOrEmpty } from '@shared/unknown-value.ts'
import { formDataString } from './fields.ts'
import {
  fetchDynamicModelOptions,
  fetchModelOptions,
  fetchSmallTasksModelOptions,
} from '../model-options.ts'
import { mountModelSelectPicker } from '../model-picker.ts'
import { createModelRoutingSection } from '../setup/model-routing-section.ts'
import { createModelParametersSection } from '../setup/model-parameters-section.ts'
export interface ModelsSection {
  load(snapshot: SettingsSnapshot): void
  refresh(snapshot: SettingsSnapshot, signal: AbortSignal): Promise<void>
  refreshWorker(snapshot: SettingsSnapshot, signal: AbortSignal): Promise<void>
  collect(data: FormData, dirty: ReadonlySet<string>): SettingsUpdate
  readSecurity: ReturnType<typeof createModelRoutingSection>['readValues']
  setModel: ReturnType<typeof createModelParametersSection>['setModel']
}
export function createModelsSection(overlay: HTMLElement, api: ApiClient): ModelsSection {
  let generalInitialised = false
  let workerInitialised = false
  const makerBlockList = el('div', { class: 'model-maker-block-list' })
  for (const maker of MODEL_MAKERS) {
    makerBlockList.append(
      el(
        'label',
        { class: 'checkbox-label' },
        el('input', { type: 'checkbox', name: 'blockedModelMakers', value: maker.id }),
        maker.label,
      ),
    )
  }
  qsRequired(overlay, '#settings-model-maker-block-host').append(
    el('h4', { class: 'model-role-heading' }, 'Blocked model makers'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Hide their models across OpenRouter, direct providers, and agents with a named model. Saved selections from blocked makers cannot run.',
    ),
    makerBlockList,
  )

  const modelRoutingSection = createModelRoutingSection(api, { modelScope: 'all' })
  qsRequired(overlay, '#settings-model-routing-host').append(modelRoutingSection.root)

  // Sits under the chat-model picker and starts on it, but has its own picker:
  // the parameters belong to a model, and the chat default is often a rule.
  const modelParametersSection = createModelParametersSection(api.settings, {
    mountModelPicker: (select) =>
      mountModelSelectPicker(select, {
        loadOptions: (current) => fetchModelOptions(api, current),
        ariaLabel: 'Model to tune',
        loadOnMount: false,
      }),
  })
  qsRequired(overlay, '#settings-model-parameters-host').append(modelParametersSection.root)

  const settingsModelPickers = {
    model: mountModelSelectPicker(qsRequired<HTMLSelectElement>(overlay, 'select[name="model"]'), {
      loadOptions: (current) => fetchModelOptions(api, current, { includeBestValue: true }),
      ariaLabel: 'Chat model',
      loadOnMount: false,
    }),
    smallTasksModel: mountModelSelectPicker(
      qsRequired<HTMLSelectElement>(overlay, 'select[name="smallTasksModel"]'),
      {
        loadOptions: (current) => fetchSmallTasksModelOptions(api, current),
        ariaLabel: 'Small tasks model',
        loadOnMount: false,
      },
    ),
    // Like the plugin model fields, the delegated-step worker selects a rule
    // rather than a model — the delegation happens mid-task, not now.
    orchestrationWorkerModel: mountModelSelectPicker(
      qsRequired(overlay, '#orchestrationWorkerModel'),
      {
        loadOptions: (current) => fetchDynamicModelOptions(current),
        ariaLabel: 'Worker model',
        loadOnMount: false,
      },
    ),
  }

  for (const [name, picker] of Object.entries(settingsModelPickers)) {
    qsRequired(picker.root, '.model-picker-trigger').setAttribute('data-model-setting-target', name)
  }
  return {
    load(snapshot: SettingsSnapshot): void {
      generalInitialised = false
      workerInitialised = false
      modelRoutingSection.reset()
      modelParametersSection.reset()
      modelParametersSection.load(snapshot.model ?? DEFAULT_APP_CHAT_MODEL, snapshot)
      const blocked = parseBlockedModelMakers(snapshot.blockedModelMakers)
      for (const input of makerBlockList.querySelectorAll<HTMLInputElement>('input'))
        input.checked = blocked.some((maker) => maker === input.value)
    },
    async refresh(snapshot: SettingsSnapshot, signal: AbortSignal): Promise<void> {
      const initialise = !generalInitialised
      generalInitialised = true
      await Promise.all([
        modelParametersSection.refreshOptions(signal),
        settingsModelPickers.model.refresh(
          initialise ? (snapshot.model ?? DEFAULT_APP_CHAT_MODEL) : undefined,
          signal,
        ),
        initialise
          ? modelRoutingSection.refresh(snapshot, signal)
          : modelRoutingSection.refreshOptions(signal),
        settingsModelPickers.smallTasksModel.refresh(
          initialise
            ? (stringRecordOrEmpty(snapshot.roleModels)['small-tasks'] ??
                snapshot.smallTasksModel ??
                '')
            : undefined,
          signal,
        ),
      ])
    },
    refreshWorker(snapshot: SettingsSnapshot, signal: AbortSignal): Promise<void> {
      const initialise = !workerInitialised
      workerInitialised = true
      return settingsModelPickers.orchestrationWorkerModel.refresh(
        initialise ? (snapshot.orchestrationWorkerModel ?? BEST_VALUE_MODEL_SELECTOR) : undefined,
        signal,
      )
    },
    collect(data: FormData, dirty: ReadonlySet<string>): SettingsUpdate {
      const values = modelRoutingSection.readValues()
      const roles = modelRoutingSection.readRoleModels() ?? {}
      if (dirty.has('localDefaultModel')) roles['coder'] = values.localDefaultModel
      if (dirty.has('subagentModel')) roles['research'] = values.subagentModel
      if (dirty.has('smallTasksModel'))
        roles['small-tasks'] = formDataString(data, 'smallTasksModel').trim()
      return {
        ...modelParametersSection.readUpdate(),
        ...(Object.keys(roles).length ? { roleAssignments: roles } : {}),
        ...(dirty.has('model') ? { model: formDataString(data, 'model') } : {}),
        ...(dirty.has('blockedModelMakers')
          ? { blockedModelMakers: parseBlockedModelMakers(data.getAll('blockedModelMakers')) }
          : {}),
        ...(dirty.has('localDefaultModel') ? { localDefaultModel: values.localDefaultModel } : {}),
        ...(dirty.has('subagentModel') ? { subagentModel: values.subagentModel } : {}),
        ...(dirty.has('smallTasksModel')
          ? { smallTasksModel: formDataString(data, 'smallTasksModel').trim() }
          : {}),
        ...(dirty.has('orchestrationWorkerModel')
          ? { orchestrationWorkerModel: formDataString(data, 'orchestrationWorkerModel').trim() }
          : {}),
      }
    },
    readSecurity: modelRoutingSection.readValues,
    setModel: modelParametersSection.setModel,
  }
}
