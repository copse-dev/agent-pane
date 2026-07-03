import { clear, el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { setAttentionThreads } from '../controller/attention.ts'

interface AskUserRequest {
  id: string
  /** Thread this question belongs to; undefined = not tied to a run (show anywhere). */
  threadId: string | undefined
  questions: { question: string; options?: string[] }[]
}

/**
 * Mounts the dialog that the `ask_user` agent tool drives: when the agent asks
 * one or more clarifying questions it sends an `agent:ask_user_request`, the
 * agent loop blocks, and the user's answers are returned via `ask.respond`.
 *
 * Requests are queued and shown one at a time so a second ask that arrives while
 * the first is open can't overwrite the active request's id and mis-route the
 * answer (the same hazard the approval dialog guards against). A question from a
 * thread the user isn't looking at stays queued and is surfaced as a sidebar
 * attention indicator rather than interrupting the focused thread.
 */
export function mountAskUserDialog(api: ApiClient, store: AppStore): void {
  const form = el('form', { id: 'ask-user-form', method: 'dialog' })
  const dialog = el('dialog', { id: 'ask-user-dialog' }, form)
  document.body.append(dialog)

  const queue: AskUserRequest[] = []
  let active: AskUserRequest | null = null
  // One input per question of the active request, kept in question order so
  // answers map back to questions by index.
  let inputs: HTMLTextAreaElement[] = []

  function isShowable(req: AskUserRequest): boolean {
    return !req.threadId || req.threadId === store.getState().activeThreadId
  }

  // Flag every queued question that belongs to a non-focused thread so the
  // sidebar can show an attention indicator on it.
  function syncAttention(): void {
    const activeThreadId = store.getState().activeThreadId
    const waiting = queue
      .map((req) => req.threadId)
      .filter((id): id is string => !!id && id !== activeThreadId)
    setAttentionThreads(store, 'ask', waiting)
  }

  function renderActive(): void {
    if (!active) return
    clear(form)
    inputs = []
    form.append(el('h3', { class: 'ask-user-title' }, 'The agent has a question'))

    active.questions.forEach((q, i) => {
      const input = el('textarea', {
        class: 'ask-user-input',
        rows: '2',
        'data-question-index': String(i),
      })
      inputs.push(input)

      const field = el(
        'div',
        { class: 'ask-user-field' },
        el('label', { class: 'ask-user-question' }, q.question),
      )
      if (q.options && q.options.length > 0) {
        const optionRow = el('div', { class: 'ask-user-options' })
        for (const option of q.options) {
          const button = el('button', { type: 'button', class: 'ask-user-option' }, option)
          button.addEventListener('click', () => {
            input.value = option
            input.focus()
          })
          optionRow.append(button)
        }
        field.append(optionRow)
      }
      field.append(input)
      form.append(field)
    })

    const cancelBtn = el('button', { type: 'button', class: 'ask-user-cancel' }, 'Cancel')
    cancelBtn.addEventListener('click', (event) => {
      event.preventDefault()
      cancel()
    })
    form.append(
      el(
        'div',
        { class: 'ask-user-buttons' },
        cancelBtn,
        el('button', { type: 'submit', class: 'ask-user-submit' }, 'Send answer'),
      ),
    )
    dialog.showModal()
    inputs[0]?.focus()
  }

  function showNext(): void {
    if (active) return
    const idx = queue.findIndex(isShowable)
    if (idx === -1) {
      syncAttention()
      return
    }
    active = queue.splice(idx, 1)[0] ?? null
    if (!active) return
    renderActive()
    syncAttention()
  }

  function respond(answers: string[]): void {
    const current = active
    if (!current) return
    dialog.close()
    active = null
    void api.ask.respond(current.id, answers)
    showNext()
  }

  function submit(): void {
    respond(inputs.map((input) => input.value))
  }

  function cancel(): void {
    if (!active) return
    respond(active.questions.map(() => ''))
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })

  api.agent.onAskUserRequest((req) => {
    queue.push({ id: req.id, threadId: req.threadId, questions: req.questions })
    showNext()
    // Cover the case where a modal is already up: the new background request
    // still needs to flag its thread.
    syncAttention()
  })

  // Surface a backgrounded question when the user switches to its thread
  // (also fires on project switches).
  store.on('threads_changed', () => {
    showNext()
  })
}
