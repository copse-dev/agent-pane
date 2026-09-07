import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { fetchModelOptions, type ModelOption } from './model-options.ts'
import { mountModelSelectPicker } from './model-picker.ts'

export interface ComparisonModelSelection {
  a: string
  b: string
  judge: string
}

/**
 * A comparison reviewer is a one-shot model role, not a chat session.
 *
 * `includeAgentModels: false` is the option `fetchModelOptions` documents for
 * exactly this — "Remote / ACP agents run whole chat sessions rather than
 * one-shot model roles" — and these pickers were the role pickers that never
 * passed it. So the list offered `acp:claude-agent-acp#opus (not configured)`
 * as a reviewer, which cannot review even when it *is* configured: the review
 * runs through a provider built from the model id, and an agent id is not one
 * (#2487).
 */
const REVIEWER_OPTIONS = { includeAgentModels: false } as const

const UNRUNNABLE_CURRENT_SUFFIX = / \((?:no key|not available|offline)\)$/i

async function reviewerOptions(api: ApiClient, current: string): Promise<ModelOption[]> {
  const options = await fetchModelOptions(api, current, REVIEWER_OPTIONS)
  return options.map((option) =>
    option.value === current && UNRUNNABLE_CURRENT_SUFFIX.test(option.label)
      ? { ...option, disabled: true }
      : option,
  )
}

async function refreshReviewer(
  picker: ReturnType<typeof mountModelSelectPicker>,
  select: HTMLSelectElement,
  current: string,
): Promise<void> {
  await picker.refresh(current)
  const selected = select.selectedOptions[0]
  if (selected?.disabled !== true) return

  const replacement = [...select.options].find(
    (option) => !option.disabled && option.value.length > 0,
  )
  if (!replacement) return
  select.value = replacement.value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function modelRow(label: string, select: HTMLSelectElement): HTMLElement {
  return el(
    'label',
    { class: 'approval-comparison-row' },
    el('span', { class: 'approval-comparison-label' }, label),
    select,
  )
}

/**
 * Model pickers for the "Compare models on this diff?" approval prompt.
 *
 * These offer *concrete* models, unlike the plugin settings that feed them. The
 * settings choose a rule because they are set once and read much later; this
 * dialog is the opposite — the run is about to start, its models have already
 * been resolved (and de-duplicated) by `resolveDistinctDynamicModelIds`, and the
 * question on screen is whether to spend money on those specific models. A rule
 * here would name something the prompt could not price.
 */
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
    loadOptions: (current) => reviewerOptions(api, current),
    className: 'approval-model-picker',
    ariaLabel: 'Reviewer A model',
    loadOnMount: false,
  })
  const pickerB = mountModelSelectPicker(selectB, {
    loadOptions: (current) => reviewerOptions(api, current),
    className: 'approval-model-picker',
    ariaLabel: 'Reviewer B model',
    loadOnMount: false,
  })
  const pickerJudge = mountModelSelectPicker(selectJudge, {
    loadOptions: (current) => reviewerOptions(api, current),
    className: 'approval-model-picker',
    ariaLabel: 'Judge model',
    loadOnMount: false,
  })

  void Promise.all([
    refreshReviewer(pickerA, selectA, models.a),
    refreshReviewer(pickerB, selectB, models.b),
    refreshReviewer(pickerJudge, selectJudge, models.judge),
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
