import type {
  EnvironmentSetupChange,
  EnvironmentSetupReview,
  EnvironmentSetupStatus,
  EnvironmentSuggestion,
  EnvironmentSuggestionKind,
} from '@shared/environment-setup.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { shieldIcon } from '../dom/icons.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import { uiActions } from '../ui/actions.ts'
import { createOverlayDialog } from './dialog-shell.ts'
import { showErrorToast, showToast } from './toast.ts'

/**
 * Environment setup (`docs/plans/environment-setup.md`): a quiet line at the top
 * of the thread when Copse keeps asking about things the user always approves,
 * and the review dialog it opens. Main computes every suggestion and value; this
 * view only reports which issued ids were ticked.
 */

/** Section order and titles, matching Settings → Permissions. */
const SECTIONS: ReadonlyArray<{ kind: EnvironmentSuggestionKind; title: string }> = [
  { kind: 'auto-approval-level', title: 'Shell commands' },
  { kind: 'web-origin', title: 'Web origins' },
  { kind: 'trusted-command', title: 'Trusted commands' },
  { kind: 'trusted-ssh-host', title: 'Trusted SSH hosts' },
  { kind: 'trusted-package-registry', title: 'Trusted package registries' },
]

/** How long after a run settles before asking main again. */
const RECHECK_DELAY_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

function times(count: number): string {
  return count === 1 ? 'once' : `${String(count)} times`
}

function lastSeen(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${String(days)} days ago`
}

/** "You approved this 14 times in 6 threads, most recently today." */
export function suggestionEvidence(suggestion: EnvironmentSuggestion, now?: number): string {
  const threads = suggestion.threads === 1 ? '1 thread' : `${String(suggestion.threads)} threads`
  return `You approved this ${times(suggestion.approvals)} in ${threads}, most recently ${lastSeen(suggestion.lastAt, now)}.`
}

function suggestionRow(
  suggestion: EnvironmentSuggestion,
  onToggle: () => void,
): { row: HTMLElement; box: HTMLInputElement } {
  const box = el('input', {
    type: 'checkbox',
    class: 'environment-setup-check',
    'data-suggestion-id': suggestion.id,
    'aria-describedby': `environment-setup-evidence-${suggestion.id}`,
  })
  box.checked = suggestion.checked && !suggestion.declined
  box.disabled = suggestion.declined
  box.addEventListener('change', onToggle)
  const examples = el('details', { class: 'environment-setup-examples' })
  examples.append(
    el('summary', {}, suggestion.kind === 'web-origin' ? 'Origin' : 'Recent commands'),
    ...suggestion.examples.map((example) =>
      el('code', { class: 'environment-setup-example' }, example),
    ),
  )
  const evidence = el(
    'p',
    {
      class: 'environment-setup-evidence',
      id: `environment-setup-evidence-${suggestion.id}`,
    },
    suggestion.declined
      ? `${suggestionEvidence(suggestion)} You also said no to a prompt this would allow, so it is not offered.`
      : suggestionEvidence(suggestion),
  )
  const label = el(
    'label',
    { class: 'environment-setup-label' },
    box,
    el('span', { class: 'environment-setup-title' }, suggestion.label),
  )
  const row = el(
    'li',
    {
      class: suggestion.declined
        ? 'environment-setup-row environment-setup-row-declined'
        : 'environment-setup-row',
      'data-kind': suggestion.kind,
    },
    label,
    evidence,
    el('p', { class: 'environment-setup-risk' }, suggestion.risk),
    examples,
  )
  return { row, box }
}

function changeSummary(changes: readonly EnvironmentSetupChange[]): string {
  return changes.length === 1
    ? (changes[0]?.label ?? 'Updated 1 setting')
    : `Updated ${String(changes.length)} permission settings`
}

/**
 * Open the review. Resolves once the dialog closes; `onApplied` runs after a
 * successful apply so callers can refresh what they show.
 */
export async function openEnvironmentSetupReview(
  api: ApiClient,
  onApplied: () => void = () => undefined,
): Promise<void> {
  const { dialog, open, close } = createOverlayDialog({ id: 'environment-setup-dialog' })
  dialog.setAttribute('aria-labelledby', 'environment-setup-heading')
  dialog.append(
    el('h2', { id: 'environment-setup-heading' }, 'Stop asking about what you always approve'),
    el('p', { class: 'environment-setup-lede' }, 'Looking at the prompts you answered…'),
  )
  open()

  let review: EnvironmentSetupReview
  try {
    review = await api.environmentSetup.review()
  } catch (error) {
    close()
    dialog.remove()
    showErrorToast('Could not review your prompts', error)
    return
  }

  const boxes: HTMLInputElement[] = []
  const status = el('p', { class: 'environment-setup-status', role: 'status' })
  const cancel = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Cancel')
  const apply = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary environment-setup-apply' },
    'Apply',
  )
  const refreshApply = (): void => {
    const count = boxes.filter((box) => box.checked).length
    apply.textContent =
      count === 1 ? 'Apply 1 change' : count === 0 ? 'Apply' : `Apply ${String(count)} changes`
    apply.disabled = count === 0
  }

  const body: HTMLElement[] = []
  if (review.suggestions.length === 0) {
    body.push(
      el(
        'p',
        { class: 'environment-setup-lede environment-setup-empty' },
        `Nothing to suggest yet. A suggestion appears once you approve the same kind of prompt at least 3 times, in at least 2 threads, within ${String(review.windowDays)} days.`,
      ),
    )
  } else {
    body.push(
      el(
        'p',
        { class: 'environment-setup-lede' },
        `Each change below would have removed prompts you approved in this project over the last ${String(review.windowDays)} days. They update Settings → Permissions, which applies to every project, and you can change them there later.`,
      ),
    )
    for (const section of SECTIONS) {
      const items = review.suggestions.filter((s) => s.kind === section.kind)
      if (items.length === 0) continue
      const list = el('ul', { class: 'environment-setup-list' })
      for (const suggestion of items) {
        const { row, box } = suggestionRow(suggestion, refreshApply)
        if (!suggestion.declined) boxes.push(box)
        list.append(row)
      }
      body.push(
        el(
          'section',
          { class: 'environment-setup-section', 'data-kind': section.kind },
          el('h3', {}, section.title),
          list,
        ),
      )
    }
  }
  const content = el('div', { class: 'environment-setup-content' }, ...body)
  dialog.querySelector('.environment-setup-lede')?.remove()
  dialog.append(
    content,
    status,
    uiActions(cancel, apply, { className: 'environment-setup-actions' }),
  )
  refreshApply()

  await new Promise<void>((resolve) => {
    cancel.addEventListener('click', () => {
      close()
    })
    apply.addEventListener('click', () => {
      const ids = boxes.filter((box) => box.checked).map((box) => box.dataset['suggestionId'] ?? '')
      apply.disabled = true
      status.textContent = ''
      void api.environmentSetup.apply(review.reviewId, ids).then(
        (result) => {
          close()
          if (result.applied.length === 0) return
          onApplied()
          const { undoId } = result
          showToast(changeSummary(result.applied), {
            durationMs: 12_000,
            ...(undoId
              ? {
                  action: {
                    label: 'Undo',
                    onClick: (): void => {
                      void api.environmentSetup.undo(undoId).then(
                        (undone) => {
                          onApplied()
                          if (undone.length > 0) showToast('Undone')
                        },
                        (error: unknown) => {
                          showErrorToast('Could not undo', error)
                        },
                      )
                    },
                  },
                }
              : {}),
          })
        },
        (error: unknown) => {
          status.textContent = ipcErrorMessage(error, 'Could not apply these changes.')
          refreshApply()
        },
      )
    })
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove()
        resolve()
      },
      { once: true },
    )
    const firstTicked = boxes.find((box) => box.checked)
    if (firstTicked) firstTicked.focus()
    else cancel.focus()
  })
}

/**
 * Mount the offer line at the top of the thread. It asks main whether to offer
 * when the project changes and shortly after a run settles, since a run is what
 * adds answered prompts.
 */
export function mountEnvironmentSetupOffer(
  store: AppStore,
  api: ApiClient,
): { element: HTMLElement; destroy: () => void } {
  const text = el('span', { class: 'environment-setup-notice-text' })
  const review = el(
    'button',
    { type: 'button', class: 'environment-setup-notice-review' },
    'Review',
  )
  const notNow = el(
    'button',
    { type: 'button', class: 'environment-setup-notice-dismiss' },
    'Not now',
  )
  const never = el(
    'button',
    { type: 'button', class: 'environment-setup-notice-dismiss environment-setup-notice-never' },
    'Don’t suggest again',
  )
  const host = el(
    'div',
    { class: 'environment-setup-notice', role: 'status', hidden: true },
    shieldIcon('ui-icon'),
    text,
    review,
    notNow,
    never,
  )
  let destroyed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  const evaluate = async (): Promise<void> => {
    const current = ++generation
    let status: EnvironmentSetupStatus
    try {
      status = await api.environmentSetup.status()
    } catch {
      return
    }
    if (destroyed || current !== generation) return
    host.hidden = !status.offer
    text.textContent = `Copse asked you ${String(status.promptCount)} times this week about things you always approve.`
  }

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void evaluate()
    }, RECHECK_DELAY_MS)
  }

  const dismiss = (forever: boolean): void => {
    host.hidden = true
    generation++
    void api.environmentSetup.dismiss(forever).catch((error: unknown) => {
      showErrorToast('Could not save your answer', error)
    })
  }

  review.addEventListener('click', () => {
    host.hidden = true
    generation++
    void openEnvironmentSetupReview(api)
  })
  notNow.addEventListener('click', () => {
    dismiss(false)
  })
  never.addEventListener('click', () => {
    dismiss(true)
  })

  const unsubscribeWorkspace = store.on('workspace_changed', () => {
    void evaluate()
  })
  const unsubscribeStatus = store.on('thread_status_changed', schedule)
  void evaluate()
  return {
    element: host,
    destroy: (): void => {
      destroyed = true
      if (timer !== null) clearTimeout(timer)
      unsubscribeWorkspace()
      unsubscribeStatus()
      host.remove()
    },
  }
}
