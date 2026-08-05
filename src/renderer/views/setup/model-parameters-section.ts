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
  // Offered, never applied: the button fills the visible fields so the recipe
  // is on screen and editable before anything is saved or sent.
  const recommendBtn = el(
    'button',
    { type: 'button', class: 'provider-secondary', 'data-testid': 'model-parameter-recommend' },
    'Use recommended',
  )
  const recommendNote = el('p', { class: 'field-hint model-parameter-recommend-note' })
  const recommendRow = el(
    'div',
    { class: 'model-parameter-recommend', hidden: '' },
    recommendBtn,
    recommendNote,
  )
  const note = el('p', { class: 'settings-fieldset-desc model-parameter-note' })
  const root = el(
    'div',
    { class: 'model-parameter-section', 'data-testid': 'model-parameters' },
    el('h4', { class: 'model-role-heading' }, 'Model parameters'),
    note,
    fields,
    recommendRow,
  )

  const reasoningSelect = el('select', {
    name: 'modelReasoning',
    'data-testid': 'model-parameter-reasoning',
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
      'model card',
    )
    // Name the source rather than asserting the numbers are right: the recipe
    // is only as current as the version it was read against.
    recommendNote.replaceChildren(
      document.createTextNode(`${recommendation.label} — fills the fields above from its `),
      link,
      document.createTextNode('. Change or clear them afterwards like any other value.'),
    )
  }

  /**
   * The one thing here that is applied rather than offered: a model card that
   * publishes an output ceiling for its deeper reasoning levels gets that
   * ceiling sent automatically, so the level says whether it is in force.
   */
  function ceilingHint(): string {
    const ceiling = recommendedModelParameters(current)?.outputCeiling
    if (!ceiling) return ''
    const tokens = `${String(Math.round(ceiling.tokens / 1000))}K`
    // Phrased for the whole ladder rather than for the level currently picked,
    // so it stays true without re-rendering the field under the user's cursor.
    return `At ${ceiling.fromReasoning} and deeper, Copse allows up to ${tokens} output tokens, as this model’s card recommends.`
  }

  function render(): void {
    const support = modelParameterSupport(current)
    const params = selected()
    fields.replaceChildren()
    renderRecommendation()

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
      support.reasoning.length > 0 && support.sampling.length === 0
        ? 'This model does not accept sampling parameters — it reasons instead of sampling.'
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
          hint: [
            'How much the model thinks before answering. Higher costs more tokens and time.',
            // The one value applied without being asked for, so it is stated
            // where the level that triggers it is chosen.
            ceilingHint(),
          ]
            .filter(Boolean)
            .join(' '),
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
      fields.append(
        uiField({
          label: spec.label,
          control: input,
          hint: `${String(SAMPLING_BOUNDS[field].min)}–${String(max)}. ${spec.hint} Blank uses the model’s own default.`,
        }),
      )
    }
  }

  reasoningSelect.addEventListener('change', () => {
    const value = reasoningSelect.value
    const { reasoning: _dropped, ...rest } = selected()
    commit(isReasoningLevel(value) ? { ...rest, reasoning: value } : rest)
  })
  recommendBtn.addEventListener('click', () => {
    const recommendation = recommendedModelParameters(current)
    if (!recommendation) return
    commit({ ...selected(), ...recommendation.params })
    render()
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
