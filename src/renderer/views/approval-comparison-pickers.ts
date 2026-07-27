import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { fetchModelOptions } from './model-options.ts'
import { mountModelSelectPicker } from './model-picker.ts'

export interface ComparisonModelSelection {
  a: string
  b: string
  judge: string
}

function modelRow(label: string, select: HTMLSelectElement): HTMLElement {
  return el(
    'label',
    { class: 'approval-comparison-row' },
    el('span', { class: 'approval-comparison-label' }, label),
    select,
  )
}

/** Model pickers for the "Compare models on this diff?" approval prompt. */
export function createComparisonModelPickers(
  api: ApiClient,
  models: ComparisonModelSelection,
  intro: string,
): { root: HTMLElement; read: () => ComparisonModelSelection } {
  const selectA = el('select', { class: 'approval-model-select' })
  const selectB = el('select', { class: 'approval-model-select' })
  const selectJudge = el('select', { class: 'approval-model-select' })

  for (const select of [selectA, selectB, selectJudge]) {
    select.append(el('option', { value: '' }, '(loading…)'))
  }

  const root = el(
    'div',
    { class: 'approval-comparison-models' },
    el('p', { class: 'approval-comparison-intro' }, intro),
    modelRow('Reviewer A', selectA),
    modelRow('Reviewer B', selectB),
    modelRow('Judge', selectJudge),
  )

  const pickerA = mountModelSelectPicker(selectA, {
    loadOptions: (current) => fetchModelOptions(api, current),
    className: 'approval-model-picker',
    ariaLabel: 'Reviewer A model',
    loadOnMount: false,
  })
  const pickerB = mountModelSelectPicker(selectB, {
    loadOptions: (current) => fetchModelOptions(api, current),
    className: 'approval-model-picker',
    ariaLabel: 'Reviewer B model',
    loadOnMount: false,
  })
  const pickerJudge = mountModelSelectPicker(selectJudge, {
    loadOptions: (current) => fetchModelOptions(api, current),
    className: 'approval-model-picker',
    ariaLabel: 'Judge model',
    loadOnMount: false,
  })

  void Promise.all([
    pickerA.refresh(models.a),
    pickerB.refresh(models.b),
    pickerJudge.refresh(models.judge),
  ])

  return {
    root,
    read: () => ({
      a: selectA.value,
      b: selectB.value,
      judge: selectJudge.value,
    }),
  }
}
