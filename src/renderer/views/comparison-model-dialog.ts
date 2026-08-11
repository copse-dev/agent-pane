import { el, clear } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  createComparisonModelPickers,
  type ComparisonModelSelection,
} from './approval-comparison-pickers.ts'

/**
 * The model picker behind the "Compare models" follow-up bubble.
 *
 * This is the same three-picker body the comparison *approval* prompt shows, in
 * a dialog the user opened themselves. That difference is the whole point: an
 * approval is a question asked of someone who was doing something else, so it
 * interrupts and rings the alert channels; this opens on a click, in the
 * foreground, and answers a question the user just asked. Pressing Run is the
 * spend decision, so the run behind it raises no second prompt
 * (`model-comparison-runner.ts`).
 *
 * Resolves with the chosen models, or null when cancelled.
 */
let dialogEl: HTMLDialogElement | null = null

function ensureDialog(): HTMLDialogElement {
  if (dialogEl) return dialogEl
  dialogEl = el('dialog', {
    id: 'comparison-model-dialog',
    class: 'comparison-model-dialog',
  })
  document.body.append(dialogEl)
  return dialogEl
}

export function openComparisonModelDialog(
  api: ApiClient,
  models: ComparisonModelSelection,
): Promise<ComparisonModelSelection | null> {
  const dialog = ensureDialog()
  clear(dialog)

  const pickers = createComparisonModelPickers(
    api,
    models,
    'Each reviewer independently reads the working diff; a judge compares their verdicts.',
  )
  const runBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary comparison-model-dialog-run' },
    'Run comparison',
  )
  const cancelBtn = el(
    'button',
    { type: 'button', class: 'ui-btn comparison-model-dialog-cancel' },
    'Cancel',
  )

  dialog.append(
    el('h3', {}, 'Compare models on this diff'),
    pickers.root,
    // Three inferences, and the picker is the only place their cost is named
    // before they run — there is no follow-up prompt to disclose it later.
    el(
      'p',
      { class: 'field-hint comparison-model-dialog-cost' },
      'Runs three model calls: two reviews and one judgement. Any model that is not local is billed.',
    ),
    el('div', { class: 'comparison-model-dialog-actions' }, cancelBtn, runBtn),
  )

  return new Promise((resolve) => {
    let settled = false
    // The <dialog> is a module-level singleton reused across opens, so listeners
    // bound to it (rather than to this open's children) would stack up on every
    // call. Tie them to this open and drop them when it settles.
    const perOpen = new AbortController()
    const finish = (value: ComparisonModelSelection | null): void => {
      if (settled) return
      settled = true
      perOpen.abort()
      dialog.close()
      resolve(value)
    }

    dialog.addEventListener(
      'cancel',
      () => {
        finish(null)
      },
      { signal: perOpen.signal },
    )
    cancelBtn.addEventListener('click', () => {
      finish(null)
    })
    runBtn.addEventListener('click', () => {
      const picked = pickers.read()
      // The pickers start on "(loading…)" and fill in asynchronously; a click
      // that lands first would otherwise start a run against blank model ids.
      if (!picked.a || !picked.b || !picked.judge) return
      finish(picked)
    })

    dialog.showModal()
    runBtn.focus()
  })
}
