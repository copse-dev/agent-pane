import type { ApiClient } from '../../../preload/api.d.ts'
import { el } from '../../dom/helpers.ts'
import { uiField } from '../../ui/index.ts'
import { modelDisplayLabel } from '../model-options.ts'
import {
  decodeModelParametersMap,
  isEmptyModelParameters,
  isReasoningLevel,
  modelParameterSupport,
  recommendedModelParameters,
  sanitizeModelParameters,
  SAMPLING_BOUNDS,
  SAMPLING_FIELDS,
  type ModelParameters,
  type ReasoningLevel,
  type SamplingField,
} from '@copse/llm/model-parameters.ts'

export interface ModelParametersSection {
  root: HTMLElement
  /** Load the saved map from settings and start on the chat model, when it is tunable. */
  refresh: (chatModel: string) => Promise<void>
  /**
   * Follow a newly picked chat model. A rule or agent selection has no
   * parameters of its own, so it leaves whatever model is being tuned in place.
   */
  setModel: (chatModel: string) => void
  /** Persist the map when the user changed something; a no-op otherwise. */
  save: () => Promise<void>
}

/** The searchable picker Settings mounts over the section's native select. */
interface ModelPickerHandle {
  refresh: (current?: string) => Promise<void>
}

export interface ModelParametersSectionOptions {
  /** Mount a picker over the native select; without one the select is used as is. */
  mountModelPicker?: (select: HTMLSelectElement) => ModelPickerHandle
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

/**
 * How each sampling knob is presented.
 *
 * Hints say what the knob *does* rather than restating its range, which the
 * input's own bounds already carry. The two cutoffs and the two penalties are
 * unfamiliar enough that a user meeting them in a vendor recipe needs to know
 * which way is "off" — every hint names its neutral value.
 */
const SAMPLING_CONTROLS: Readonly<
  Record<SamplingField, { label: string; name: string; testid: string; hint: string }>
> = {
  temperature: {
    label: 'Temperature',
    name: 'modelTemperature',
    testid: 'model-parameter-temperature',
    hint: 'Lower is more repeatable, higher more varied.',
  },
  topP: {
    label: 'Top-p',
    name: 'modelTopP',
    testid: 'model-parameter-top-p',
    hint: 'Nucleus cutoff: sample from the likeliest tokens whose probabilities sum to this. 1 considers all of them.',
  },
  topK: {
    label: 'Top-k',
    name: 'modelTopK',
    testid: 'model-parameter-top-k',
    hint: 'Consider only this many candidate tokens at each step. 0 considers all of them.',
  },
  minP: {
    label: 'Min-p',
    name: 'modelMinP',
    testid: 'model-parameter-min-p',
    hint: 'Drop tokens below this fraction of the likeliest one’s probability. 0 drops nothing.',
  },
  presencePenalty: {
    label: 'Presence penalty',
    name: 'modelPresencePenalty',
    testid: 'model-parameter-presence-penalty',
    hint: 'Discourage reusing tokens already in the reply. 0 is off; high values can cause language mixing.',
  },
  repetitionPenalty: {
    label: 'Repetition penalty',
    name: 'modelRepetitionPenalty',
    testid: 'model-parameter-repetition-penalty',
    hint: 'Divides the likelihood of tokens already seen. 1 is off — below 1 encourages repetition.',
  },
}

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

/** The recipe value itself, in placeholder grey; the fields are too narrow for a label. */
function samplingPlaceholder(recipeValue: number | undefined, fallback: string): string {
  return recipeValue === undefined ? fallback : String(recipeValue)
}

function blankHint(recipeValue: number | undefined, fallback: string): string {
  return recipeValue === undefined
    ? fallback
    : `Blank sends the recommended ${String(recipeValue)}.`
}

/**
 * Per-model generation parameters, in Settings → Models.
 *
 * The parameters belong to the *model*, not to the chat-model field: the same
 * knobs apply wherever that model runs, exactly as an ACP agent's model and
 * permission mode are configured once on the agent. So the section has its own
 * model picker and edits one entry of a selection-keyed map. It starts on the
 * chat model, but tuning a model never changes the default — the default is
 * often a rule (`auto:balanced`) that has no parameters to tune at all.
 *
 * A model with a curated recipe runs on it unless told otherwise, so the
 * recipe's values sit in the fields as placeholders and anything typed replaces
 * that one value (see `resolveModelParameters`).
 *
 * Which controls appear is decided by the model, not by us: the newest Claude
 * models reject `temperature`/`top_p` outright and the older ones have no
 * reasoning ladder, so offering every control everywhere would invite a 400 the
 * user could not have predicted. Unsupported controls are omitted, with a line
 * saying why.
 */
export function createModelParametersSection(
  api: Pick<ApiClient['settings'], 'get' | 'set'>,
  options: ModelParametersSectionOptions = {},
): ModelParametersSection {
  const fields = el('div', { class: 'model-parameter-fields' })
  // No `name`: the model being tuned is not a setting, so the settings form's
  // FormData must not pick it up.
  const modelSelect = el('select', {
    id: 'settings-model-parameters-model',
    'data-testid': 'model-parameter-model',
  })
  const modelField = uiField({
    label: 'Model to tune',
    control: modelSelect,
    hint: 'Any model you can pick. Changing this does not change your chat model.',
  })
  // Models the user has saved values for, so they can be found again without
  // remembering which ones they touched.
  const customisedList = el('div', { class: 'provider-chips model-parameter-customised' })
  const customisedRow = el(
    'div',
    { class: 'model-parameter-customised-row', 'data-testid': 'model-parameter-customised' },
    el('span', { class: 'field-hint' }, 'Customised:'),
    customisedList,
  )
  const recommendNote = el('p', { class: 'field-hint model-parameter-recommend-note' })
  const recommendRow = el(
    'div',
    { class: 'model-parameter-recommend', 'data-testid': 'model-parameter-recommend' },
    recommendNote,
  )
  const resetBtn = el('button', {
    type: 'button',
    class: 'provider-secondary',
    'data-testid': 'model-parameter-reset',
  })
  const note = el('p', { class: 'settings-fieldset-desc model-parameter-note' })
  const root = el(
    'div',
    { class: 'model-parameter-section', 'data-testid': 'model-parameters' },
    // Which model, and what it runs on before any field is touched.
    el(
      'div',
      { class: 'model-parameter-header', 'data-testid': 'model-parameter-header' },
      el('h4', { class: 'model-role-heading' }, 'Model parameters'),
      modelField,
      customisedRow,
      note,
      recommendRow,
    ),
    fields,
    resetBtn,
  )
  const picker = options.mountModelPicker?.(modelSelect)

  const reasoningSelect = el('select', {
    name: 'modelReasoning',
    'data-testid': 'model-parameter-reasoning',
  })
  const maxOutputTokensInput = el('input', {
    type: 'number',
    name: 'modelMaxOutputTokens',
    min: '256',
    max: '1000000',
    step: '1',
    placeholder: 'Provider default',
    'data-testid': 'model-parameter-max-output-tokens',
  })
  maxOutputTokensInput.addEventListener('change', () => {
    const { maxOutputTokens: _dropped, ...rest } = selected()
    const value = readNumberInput(maxOutputTokensInput)
    commit(value === undefined ? rest : { ...rest, maxOutputTokens: value })
    maxOutputTokensInput.value = formatNumber(selected().maxOutputTokens)
  })
  const samplingInputs = new Map<SamplingField, HTMLInputElement>(
    SAMPLING_FIELDS.map((field) => {
      const spec = SAMPLING_CONTROLS[field]
      const bounds = SAMPLING_BOUNDS[field]
      const input = el('input', {
        type: 'number',
        name: spec.name,
        min: String(bounds.min),
        max: String(bounds.max),
        step: bounds.integer ? '1' : '0.05',
        placeholder: 'Model default',
        'data-testid': spec.testid,
      })
      input.addEventListener('change', () => {
        const { [field]: _dropped, ...rest } = selected()
        const value = readNumberInput(input)
        commit(value === undefined ? rest : { ...rest, [field]: value })
        // Reflect the clamp/round the model's bounds applied, so the field shows
        // what will actually be sent rather than what was typed.
        input.value = formatNumber(selected()[field])
      })
      return [field, input]
    }),
  )

  // The saved map for every model, not just the selected one: the user can
  // switch models in the picker above and tune several before saving once.
  let stored: Record<string, ModelParameters> = {}
  let current = ''
  let dirty = false

  function selected(): ModelParameters {
    return stored[current] ?? {}
  }

  /** What the model runs on when a field is left blank. */
  function recipe(): ModelParameters {
    return recommendedModelParameters(current)?.params ?? {}
  }

  function commit(next: ModelParameters): void {
    dirty = true
    const sanitized = sanitizeModelParameters(next, current)
    if (isEmptyModelParameters(sanitized)) {
      // Clearing every field removes the entry rather than persisting an empty
      // object, so the settings file stays a record of what was actually tuned.
      const { [current]: _cleared, ...rest } = stored
      stored = rest
    } else {
      stored = { ...stored, [current]: sanitized }
    }
    renderCustomised()
    renderReset()
  }

  function renderCustomised(): void {
    const models = Object.keys(stored)
    customisedRow.hidden = models.length === 0
    customisedList.replaceChildren(
      ...models.map((model) => {
        const chip = el(
          'button',
          {
            type: 'button',
            class: model === current ? 'provider-chip active' : 'provider-chip',
            'aria-pressed': String(model === current),
            'data-model': model,
          },
          modelDisplayLabel(model),
        )
        chip.addEventListener('click', () => {
          selectModel(model)
          void picker?.refresh(model)
        })
        return chip
      }),
    )
  }

  function renderReset(): void {
    resetBtn.hidden = stored[current] === undefined
    resetBtn.textContent =
      recommendedModelParameters(current) === null ? 'Clear custom values' : 'Reset to recommended'
  }

  function renderRecommendation(): void {
    const recommendation = recommendedModelParameters(current)
    if (!recommendation) {
      recommendRow.hidden = true
      recommendNote.replaceChildren()
      return
    }
    recommendRow.hidden = false
    const link = el(
      'a',
      { href: recommendation.source, target: '_blank', rel: 'noopener noreferrer' },
      recommendation.sourceLabel ?? 'model card',
    )
    // Name the source rather than asserting the numbers are right: the recipe
    // is only as current as the version it was read against.
    recommendNote.replaceChildren(
      document.createTextNode(`Applied by default: ${recommendation.label}, from its `),
      link,
      document.createTextNode(
        '. Blank fields use it; a value you enter replaces the recommended one.',
      ),
    )
  }

  /**
   * The one thing here that is applied rather than offered: a card that
   * publishes an output ceiling gets it sent automatically.
   *
   * A ceiling gated on a reasoning depth is stated beside the control that
   * triggers it; an unconditional one belongs in the section note, since no
   * field the user can touch turns it on or off. Both are phrased for the whole
   * ladder rather than for the level currently picked, so neither has to
   * re-render a field under the user's cursor.
   */
  function ceilingHint(gated: boolean): string {
    const ceiling = recommendedModelParameters(current)?.outputCeiling
    if (!ceiling || (ceiling.fromReasoning !== undefined) !== gated) return ''
    const tokens = `${String(Math.round(ceiling.tokens / 1000))}K output tokens, as this model’s card recommends.`
    return ceiling.fromReasoning === undefined
      ? `Copse allows up to ${tokens}`
      : `At ${ceiling.fromReasoning} and deeper, Copse allows up to ${tokens}`
  }

  function render(): void {
    const support = modelParameterSupport(current)
    const params = selected()
    const defaults = recipe()
    fields.replaceChildren()
    renderRecommendation()
    renderCustomised()
    renderReset()

    if (!current) {
      note.textContent = 'Choose a model to tune how it runs, wherever it is used.'
      return
    }
    if (support.unavailableReason) {
      note.textContent = support.unavailableReason
      return
    }

    const parts = [
      `Sent with every turn that uses ${modelDisplayLabel(current)}, wherever it runs.`,
      support.upstreamDecides
        ? 'This provider passes them upstream, so which values take effect is up to the model behind it.'
        : '',
      support.reasoning.length > 0 && support.sampling.length === 0
        ? 'This model does not accept sampling parameters — it reasons instead of sampling.'
        : '',
      support.reasoning.length === 0 ? 'This model exposes no reasoning control.' : '',
      ceilingHint(false),
    ].filter(Boolean)
    note.textContent = parts.join(' ')

    if (support.reasoning.length > 0) {
      reasoningSelect.replaceChildren(
        el(
          'option',
          { value: '' },
          defaults.reasoning === undefined
            ? DEFAULT_OPTION_LABEL
            : `Recommended (${REASONING_LABELS[defaults.reasoning]})`,
        ),
        ...support.reasoning.map((level) =>
          el('option', { value: level }, REASONING_LABELS[level]),
        ),
      )
      reasoningSelect.value = params.reasoning ?? ''
      fields.append(
        uiField({
          label: 'Reasoning',
          control: reasoningSelect,
          hint: [
            'How much the model thinks before answering. Higher costs more tokens and time.',
            // The one value applied without being asked for, so it is stated
            // where the level that triggers it is chosen.
            ceilingHint(true),
          ]
            .filter(Boolean)
            .join(' '),
        }),
      )
    }

    if (support.outputCap) {
      maxOutputTokensInput.value = formatNumber(params.maxOutputTokens)
      maxOutputTokensInput.placeholder = samplingPlaceholder(
        defaults.maxOutputTokens,
        'Provider default',
      )
      fields.append(
        uiField({
          label: 'Maximum output tokens',
          control: maxOutputTokensInput,
          hint: `Per response, including hidden reasoning. ${blankHint(defaults.maxOutputTokens, 'Blank uses the provider default.')} A low cap can truncate a tool call.`,
        }),
      )
    }

    // Only the knobs this route accepts. `top_k` and `min_p` are not OpenAI
    // parameters and `presence_penalty` has no Anthropic equivalent, so a fixed
    // set of fields would invite a 400 the user could not have predicted.
    for (const field of support.sampling) {
      const input = samplingInputs.get(field)
      if (!input) continue
      const spec = SAMPLING_CONTROLS[field]
      // Temperature is the one bound that moves with the family.
      const max = field === 'temperature' ? support.temperatureMax : SAMPLING_BOUNDS[field].max
      input.max = String(max)
      input.value = formatNumber(params[field])
      input.placeholder = samplingPlaceholder(defaults[field], 'Model default')
      const blank = blankHint(defaults[field], 'Blank uses the model’s own default.')
      fields.append(
        uiField({
          label: spec.label,
          control: input,
          hint: `${String(SAMPLING_BOUNDS[field].min)}–${String(max)}. ${spec.hint} ${blank}`,
        }),
      )
    }
  }

  reasoningSelect.addEventListener('change', () => {
    const value = reasoningSelect.value
    const { reasoning: _dropped, ...rest } = selected()
    commit(isReasoningLevel(value) ? { ...rest, reasoning: value } : rest)
  })
  resetBtn.addEventListener('click', () => {
    commit({})
    render()
  })
  modelSelect.addEventListener('change', () => {
    selectModel(modelSelect.value)
  })

  function selectModel(model: string): void {
    current = model.trim()
    // Without a mounted picker the native select is the control, and it can
    // only show a value it has an option for.
    if (current && ![...modelSelect.options].some((option) => option.value === current)) {
      modelSelect.append(el('option', { value: current }, modelDisplayLabel(current)))
    }
    modelSelect.value = current
    render()
  }

  function setModel(chatModel: string): void {
    const model = chatModel.trim()
    // A rule or an agent has nothing to tune; keep the model the user is on.
    if (!model || modelParameterSupport(model).unavailableReason) {
      render()
      return
    }
    selectModel(model)
    void picker?.refresh(current)
  }

  async function refresh(chatModel: string): Promise<void> {
    try {
      stored = decodeModelParametersMap(await api.get('modelParameters'))
    } catch {
      stored = {}
    }
    dirty = false
    setModel(chatModel)
    await picker?.refresh(current)
  }

  async function save(): Promise<void> {
    if (!dirty) return
    await api.set('modelParameters', stored)
    dirty = false
  }

  return { root, refresh, setModel, save }
}
