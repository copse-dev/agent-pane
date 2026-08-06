import { el, on } from '../dom/helpers.ts'
import {
  modelParameterSupport,
  isReasoningLevel,
  type ReasoningLevel,
} from '@copse/llm/model-parameters.ts'

export interface FooterReasoningDial {
  root: HTMLElement
  /** Re-read the current model and level, and show or hide accordingly. */
  sync: () => void
  destroy: () => void
}

/** Short labels: this sits in the footer strip, beside the model name. */
const SHORT_LABELS: Record<ReasoningLevel, string> = {
  off: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

const DEFAULT_LABEL = 'Default effort'

/**
 * Per-chat reasoning dial, beside the composer's model picker.
 *
 * The model picker already scopes a choice to this chat; effort is the other
 * knob a user reaches for mid-task ("this one's hard"), and making them open
 * Settings for it would mean permanently re-tuning the model to get through one
 * turn. So this writes to the *thread*, overriding the model's saved level for
 * this chat's turns only.
 *
 * Hidden entirely when the selected model exposes no reasoning control — a
 * disabled control next to the composer would be a permanent question with no
 * answer. Only the levels that model accepts are offered.
 */
export function mountFooterReasoningDial(
  root: HTMLElement,
  getModel: () => string,
  getLevel: () => ReasoningLevel | undefined,
  onSelect: (level: ReasoningLevel | undefined) => void,
): FooterReasoningDial {
  const select = el('select', {
    class: 'footer-reasoning-select',
    'aria-label': 'Reasoning effort for this chat',
    'data-testid': 'footer-reasoning',
  })
  const wrap = el('div', { class: 'footer-reasoning', hidden: '' }, select)
  root.append(wrap)

  const cleanups: Array<() => void> = [
    on(select, 'change', () => {
      onSelect(isReasoningLevel(select.value) ? select.value : undefined)
    }),
  ]

  function sync(): void {
    const levels = modelParameterSupport(getModel()).reasoning
    if (levels.length === 0) {
      wrap.hidden = true
      return
    }
    wrap.hidden = false
    const level = getLevel()
    select.replaceChildren(
      el('option', { value: '' }, DEFAULT_LABEL),
      ...levels.map((candidate) => el('option', { value: candidate }, SHORT_LABELS[candidate])),
    )
    // A level saved against a model that no longer offers it (the picker moved
    // on) shows as the default rather than as a value we would silently drop.
    select.value = level !== undefined && levels.includes(level) ? level : ''
    // The trigger reads as "set" only while it overrides the model's own level,
    // so a glance at the footer says whether this chat is running hotter.
    wrap.classList.toggle('is-set', select.value !== '')
  }

  sync()

  return {
    root: wrap,
    sync,
    destroy: (): void => {
      cleanups.forEach((cleanup) => {
        cleanup()
      })
      wrap.remove()
    },
  }
}
