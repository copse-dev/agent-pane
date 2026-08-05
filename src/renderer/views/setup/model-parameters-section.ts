import type { ApiClient } from '../../../preload/api.d.ts'
import { el } from '../../dom/helpers.ts'
import { uiField } from '../../ui/index.ts'
import { modelDisplayLabel } from '../model-options.ts'
import {
  decodeModelParametersMap,
  isEmptyModelParameters,
  isReasoningLevel,
  modelParameterSupport,
  sanitizeModelParameters,
  type ModelParameters,
  type ReasoningLevel,
} from '@copse/llm/model-parameters.ts'

export interface ModelParametersSection {
  root: HTMLElement
  /** Load the saved map from settings and render it for `model`. */
  refresh: (model: string) => Promise<void>
  /** Re-render for a newly picked model without re-reading settings. */
  setModel: (model: string) => void
  /** Persist the map when the user changed something; a no-op otherwise. */
  save: () => Promise<void>
}

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  off: 'Off — answer without reasoning first',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

const DEFAULT_OPTION_LABEL = "Model default (don't send)"

/** Empty input means "send nothing"; a typed number is only used when valid. */
function readNumberInput(input: HTMLInputElement): number | undefined {
  const raw = input.value.trim()
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/**
 * Per-model generation parameters, shown under the chat-model picker in
 * Settings → Models.
 *
 * The parameters belong to the *model*, not to this field: the same knobs apply
 * wherever that model runs, exactly as an ACP agent's model and permission mode
 * are configured once on the agent. So the section edits one entry of a
 * selection-keyed map and re-renders whenever the picker above it changes,
 * rather than owning a single global set of values.
 *
 * Which controls appear is decided by the model, not by us: the newest Claude
 * models reject `temperature`/`top_p` outright and the older ones have no
 * reasoning ladder, so offering every control everywhere would invite a 400 the
 * user could not have predicted. Unsupported controls are omitted, with a line
 * saying why.
 */
export function createModelParametersSection(
  api: Pick<ApiClient['settings'], 'get' | 'set'>,
): ModelParametersSection {
  const fields = el('div', { class: 'model-parameter-fields' })
  const note = el('p', { class: 'settings-fieldset-desc model-parameter-note' })
  const root = el(
    'div',
    { class: 'model-parameter-section', 'data-testid': 'model-parameters' },
    el('h4', { class: 'model-role-heading' }, 'Model parameters'),
    note,
    fields,
  )

  const reasoningSelect = el('select', {
    name: 'modelReasoning',
    'data-testid': 'model-parameter-reasoning',
  })
  const temperatureInput = el('input', {
    type: 'number',
    name: 'modelTemperature',
    min: '0',
    step: '0.05',
    placeholder: 'Model default',
    'data-testid': 'model-parameter-temperature',
  })
  const topPInput = el('input', {
    type: 'number',
    name: 'modelTopP',
    min: '0',
    max: '1',
    step: '0.05',
    placeholder: 'Model default',
    'data-testid': 'model-parameter-top-p',
  })

  // The saved map for every model, not just the selected one: the user can
  // switch models in the picker above and tune several before saving once.
  let stored: Record<string, ModelParameters> = {}
  let current = ''
  let dirty = false

  function selected(): ModelParameters {
    return stored[current] ?? {}
  }

  function commit(next: ModelParameters): void {
    dirty = true
    const sanitized = sanitizeModelParameters(next, current)
    if (isEmptyModelParameters(sanitized)) {
      // Clearing every field removes the entry rather than persisting an empty
      // object, so the settings file stays a record of what was actually tuned.
      const { [current]: _cleared, ...rest } = stored
      stored = rest
      return
    }
    stored = { ...stored, [current]: sanitized }
  }

  function render(): void {
    const support = modelParameterSupport(current)
    const params = selected()
    fields.replaceChildren()

    if (support.unavailableReason) {
      note.textContent = support.unavailableReason
      return
    }
    if (!current) {
      note.textContent = 'Choose a chat model above to tune how it runs.'
      return
    }

    const parts = [
      `Sent with every turn that uses ${modelDisplayLabel(current)}, wherever it runs.`,
      support.upstreamDecides
        ? 'This provider passes them upstream, so which values take effect is up to the model behind it.'
        : '',
      support.reasoning.length > 0 && !support.sampling
        ? 'This model does not accept temperature or top-p — it reasons instead of sampling.'
        : '',
      support.reasoning.length === 0 ? 'This model exposes no reasoning control.' : '',
    ].filter(Boolean)
    note.textContent = parts.join(' ')

    if (support.reasoning.length > 0) {
      reasoningSelect.replaceChildren(
        el('option', { value: '' }, DEFAULT_OPTION_LABEL),
        ...support.reasoning.map((level) =>
          el('option', { value: level }, REASONING_LABELS[level]),
        ),
      )
      reasoningSelect.value = params.reasoning ?? ''
      fields.append(
        uiField({
          label: 'Reasoning',
          control: reasoningSelect,
          hint: 'How much the model thinks before answering. Higher costs more tokens and time.',
        }),
      )
    }

    if (support.sampling) {
      temperatureInput.max = String(support.temperatureMax)
      temperatureInput.value = formatNumber(params.temperature)
      topPInput.value = formatNumber(params.topP)
      fields.append(
        uiField({
          label: 'Temperature',
          control: temperatureInput,
          hint: `0–${String(support.temperatureMax)}. Lower is more repeatable, higher more varied. Blank uses the model's own default.`,
        }),
        uiField({
          label: 'Top-p',
          control: topPInput,
          hint: 'Nucleus sampling cutoff (0–1). Blank uses the model’s own default.',
        }),
      )
    }
  }

  reasoningSelect.addEventListener('change', () => {
    const value = reasoningSelect.value
    const { reasoning: _dropped, ...rest } = selected()
    commit(isReasoningLevel(value) ? { ...rest, reasoning: value } : rest)
  })
  temperatureInput.addEventListener('change', () => {
    const { temperature: _dropped, ...rest } = selected()
    const temperature = readNumberInput(temperatureInput)
    commit(temperature === undefined ? rest : { ...rest, temperature })
    // Reflect the clamp/round the model's bounds applied, so the field shows
    // what will actually be sent rather than what was typed.
    temperatureInput.value = formatNumber(selected().temperature)
  })
  topPInput.addEventListener('change', () => {
    const { topP: _dropped, ...rest } = selected()
    const topP = readNumberInput(topPInput)
    commit(topP === undefined ? rest : { ...rest, topP })
    topPInput.value = formatNumber(selected().topP)
  })

  function setModel(model: string): void {
    current = model.trim()
    render()
  }

  async function refresh(model: string): Promise<void> {
    try {
      stored = decodeModelParametersMap(await api.get('modelParameters'))
    } catch {
      stored = {}
    }
    dirty = false
    setModel(model)
  }

  async function save(): Promise<void> {
    if (!dirty) return
    await api.set('modelParameters', stored)
    dirty = false
  }

  return { root, refresh, setModel, save }
}
