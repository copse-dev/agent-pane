import { z } from 'zod'
import { askUserQuestionSchema } from '@copse/agent/ask-user-format.ts'
import { el } from '../dom/helpers.ts'

export const remoteDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.uuid(),
    kind: z.literal('approval'),
    title: z.string(),
    body: z.string(),
    advice: z.string().optional(),
    footer: z.string().optional(),
  }),
  z.object({
    id: z.uuid(),
    kind: z.literal('question'),
    questions: z.array(askUserQuestionSchema).min(1).max(10),
  }),
])
export type DecisionAnswer =
  | { action: 'approval'; decisionId: string; approved: boolean }
  | { action: 'answer'; decisionId: string; answers: string[] }

/** Polls update availability without replacing a user's unfinished answer. */
export function mountRemoteDecisions(
  root: HTMLElement,
  send: (answer: DecisionAnswer) => Promise<void>,
): {
  update(decisions: z.infer<typeof remoteDecisionSchema>[], connected: boolean): void
} {
  let signature = ''
  let busy = false
  let enabled = false
  const error = el('p', { role: 'alert', hidden: true })
  function availability(): void {
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
      'button, textarea',
    ))
      control.disabled = !enabled || busy
  }
  async function submit(answer: DecisionAnswer): Promise<void> {
    if (!enabled || busy) return
    busy = true
    error.hidden = true
    availability()
    try {
      await send(answer)
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : 'Could not send your response.'
      error.hidden = false
    } finally {
      busy = false
      availability()
    }
  }
  return {
    update(decisions, connected): void {
      enabled = connected
      const next = JSON.stringify(decisions)
      if (next !== signature) {
        signature = next
        root.replaceChildren(error)
        for (const decision of decisions) {
          const card = el('section', { class: 'remote-decision', 'data-decision-id': decision.id })
          const button = (label: string, answer: () => DecisionAnswer): HTMLButtonElement => {
            const node = el('button', { type: 'button', class: 'ui-btn' }, label)
            node.onclick = (): void => {
              void submit(answer())
            }
            return node
          }
          if (decision.kind === 'approval') {
            card.append(el('strong', {}, decision.title), el('pre', {}, decision.body))
            if (decision.advice) card.append(el('p', {}, decision.advice))
            if (decision.footer) card.append(el('p', {}, decision.footer))
            for (const approved of [false, true])
              card.append(
                button(approved ? 'Approve' : 'Deny', () => ({
                  action: 'approval',
                  decisionId: decision.id,
                  approved,
                })),
              )
          } else {
            const inputs = decision.questions.map((question, index) => {
              const id = `remote-answer-${decision.id}-${String(index)}`
              const input = el('textarea', { id, maxlength: '8000', rows: '2' })
              card.append(el('label', { for: id }, question.question), input)
              for (const option of question.options ?? []) {
                const choose = el('button', { type: 'button', class: 'ui-btn' }, option)
                choose.onclick = (): void => {
                  input.value = option
                }
                card.append(choose)
              }
              return input
            })
            card.append(
              button('Send answers', () => ({
                action: 'answer',
                decisionId: decision.id,
                answers: inputs.map((input) => input.value),
              })),
            )
          }
          root.append(card)
        }
      }
      availability()
    },
  }
}
