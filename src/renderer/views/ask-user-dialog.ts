import { clear, el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'

interface AskUserRequest {
  id: string
  questions: { question: string; options?: string[] }[]
}

/**
 * Mounts the dialog that the `ask_user` agent tool drives: when the agent asks
 * one or more clarifying questions it sends an `agent:ask_user_request`, the
 * agent loop blocks, and the user's answers are returned via `ask.respond`.
 *
 * Requests are queued and shown one at a time so a second ask that arrives while
 * the first is open can't overwrite the active request's id and mis-route the
 * answer (the same hazard the approval dialog guards against).
 */
export function mountAskUserDialog(api: ApiClient): void {
  const form = el('form', { id: 'ask-user-form', method: 'dialog' })
  const dialog = el('dialog', { id: 'ask-user-dialog' }, form)
  document.body.append(dialog)

  const queue: AskUserRequest[] = []
  let active: AskUserRequest | null = null
  // One input per question of the active request, kept in question order so
  // answers map back to questions by index.
  let inputs: HTMLTextAreaElement[] = []

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

    form.append(
      el(
        'div',
        { class: 'ask-user-buttons' },
        el('button', { type: 'submit', class: 'ask-user-submit' }, 'Send answer'),
      ),
    )
    dialog.showModal()
    inputs[0]?.focus()
  }

  function showNext(): void {
    active = queue.shift() ?? null
    if (!active) return
    renderActive()
  }

  function submit(): void {
    const current = active
    if (!current) return
    const answers = inputs.map((input) => input.value)
    dialog.close()
    active = null
    void api.ask.respond(current.id, answers)
    showNext()
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })

  api.agent.onAskUserRequest((req) => {
    queue.push(req)
    if (!active) showNext()
  })
}
