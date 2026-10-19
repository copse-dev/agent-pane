import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import { SERVICE_TIER_CHOICES, isServiceTier } from '@copse/llm/service-tier.ts'
import { el } from '../../dom/helpers.ts'
import { uiField } from '../../ui/index.ts'

// The Settings-only global request tier for first-party OpenAI API models,
// shown under the OpenAI API key's Options. The picker presents semantic
// choices while preserving the stored bytes until the user actually changes
// one: an old blank value is equivalent to `auto`, and `priority` is the legacy
// spelling of Fast mode.

export interface OpenAiServiceTierField {
  refresh: (snapshot?: SettingsSnapshot, signal?: AbortSignal) => Promise<void>
  /** A fresh block reflecting the pending choice (the host re-renders freely). */
  element: () => HTMLElement
  readUpdate: () => SettingsUpdate
  reset: () => void
}

const OFFERED = new Set<string>(SERVICE_TIER_CHOICES.map((choice) => choice.value))

function choiceForStored(value: string): string {
  if (value === '') return 'auto'
  if (value === 'priority') return 'fast'
  return value
}

function retainedLabel(value: string): string {
  if (value === 'scale') return 'Scale (current advanced value)'
  const visible = value.length > 80 ? `${value.slice(0, 79)}…` : value
  return `Current advanced value: ${visible || '(empty)'}`
}

function describe(value: string): string {
  const choice = SERVICE_TIER_CHOICES.find((entry) => entry.value === value)
  if (choice) return choice.description
  if (value === 'scale') {
    return 'Uses committed Scale Tier capacity. It remains selected until you choose another tier.'
  }
  return 'This value is not offered by this version. It remains selected until you choose another tier.'
}

export function createOpenAiServiceTierField(api: ApiClient): OpenAiServiceTierField {
  let initial = 'auto'
  let pending = 'auto'
  let dirty = false
  let generation = 0
  const hasDraft = (): boolean => dirty

  async function refresh(snapshot?: SettingsSnapshot, signal?: AbortSignal): Promise<void> {
    const mine = ++generation
    if (hasDraft()) return
    const raw = snapshot ? snapshot.openAiServiceTier : await api.settings.get('openAiServiceTier')
    // The picker may have changed while the read was in flight.
    if (hasDraft() || mine !== generation || signal?.aborted) return
    initial = choiceForStored(typeof raw === 'string' ? raw : '')
    pending = initial
  }

  function element(): HTMLElement {
    const picker = el('select', {
      name: 'openAiServiceTier',
      'data-testid': 'openai-service-tier',
    })
    for (const choice of SERVICE_TIER_CHOICES) {
      picker.append(el('option', { value: choice.value }, choice.label))
    }
    if (!OFFERED.has(pending)) {
      picker.append(el('option', { value: pending }, retainedLabel(pending)))
    }
    picker.value = pending
    const field = uiField({
      label: 'Global OpenAI service tier',
      control: picker,
      hint: describe(pending),
    })
    picker.addEventListener('change', () => {
      pending = picker.value
      dirty = pending !== initial
      field.setAttribute('hint', describe(pending))
    })
    return el(
      'div',
      { class: 'provider-capability', 'data-testid': 'openai-service-tier-block' },
      el('h4', { class: 'provider-capability-title' }, 'Request processing'),
      field,
      el(
        'p',
        { class: 'field-hint openai-service-tier-scope' },
        'Applies to OpenAI API-key requests. ChatGPT plan and the Codex agent use their own processing settings. Copse records the tier OpenAI reports for each response, including a downgrade to Standard, and uses it when estimating cost.',
      ),
    )
  }

  return {
    refresh,
    element,
    readUpdate: () => (dirty && isServiceTier(pending) ? { openAiServiceTier: pending } : {}),
    reset: (): void => {
      generation += 1
      dirty = false
      pending = initial
    },
  }
}
