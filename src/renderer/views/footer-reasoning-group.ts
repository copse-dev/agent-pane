import {
  modelParameterSupport,
  isReasoningLevel,
  type ReasoningLevel,
} from '@copse/llm/model-parameters.ts'
import type { PickerValueGroup } from './model-picker.ts'

/**
 * Sentinel id for the per-chat reasoning group inside the composer's model
 * picker. It is not one of the agent's own selectors — it is ours, applied to
 * whatever model the chat is on — so the footer picker routes this id to the
 * thread rather than to the ACP persistence path.
 */
export const REASONING_GROUP_ID = '__reasoning_effort__'

/** Short labels: the picker row shows the value beside the group name. */
const LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** The "leave it to the model" choice, stored on the thread as no value at all. */
const DEFAULT_VALUE = ''
const DEFAULT_LABEL = 'Default'

/**
 * Per-chat effort as a model-picker selector, listed beside an ACP agent's own
 * knobs (mode, thinking effort) so every per-chat model choice lives in one
 * menu instead of a second control in the footer strip.
 *
 * Returns `null` when the selected model exposes no reasoning control — an
 * always-present row with nothing behind it would be a permanent question with
 * no answer. Only the levels that model accepts are offered.
 *
 * A level saved against a model that no longer offers it (the picker moved on)
 * reads as the default rather than as a value we would silently drop.
 */
export function reasoningValueGroup(
  model: string,
  level: ReasoningLevel | undefined,
): PickerValueGroup | null {
  const levels = modelParameterSupport(model).reasoning
  if (levels.length === 0) return null
  return {
    id: REASONING_GROUP_ID,
    label: 'Effort',
    currentValue: level !== undefined && levels.includes(level) ? level : DEFAULT_VALUE,
    choices: [
      {
        value: DEFAULT_VALUE,
        label: DEFAULT_LABEL,
        description: 'Use the effort saved against this model',
      },
      ...levels.map((candidate) => ({ value: candidate, label: LEVEL_LABELS[candidate] })),
    ],
  }
}

/** The thread-facing value for a pick: `undefined` clears the override. */
export function reasoningLevelFromGroupValue(value: string): ReasoningLevel | undefined {
  return isReasoningLevel(value) ? value : undefined
}
