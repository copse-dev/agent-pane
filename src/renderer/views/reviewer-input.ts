import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import {
  parseReviewerInputCall,
  reviewerInputAnswer,
  reviewerInputRequests,
  type ReviewerInputRequest,
} from '@shared/threads/reviewer-input.ts'
import type { ToolCall } from '@shared/types'
import { answerReviewerInput } from '../controller/reviewer-input.ts'

function answerText(choice: string, detail: string): string {
  return [choice, detail.trim()].filter(Boolean).join(' — ')
}

/** Compact list of saved agent questions beside the transcript. */
export function mountReviewerInput(
  store: AppStore,
  api: ApiClient,
): {
  toggle: HTMLButtonElement
  panel: HTMLElement
  sync: () => void
  open: (requestId: string) => void
} {
  const toggle = el('button', { type: 'button', class: 'reviewer-input-toggle', hidden: '' })
  const panel = el('aside', {
    class: 'reviewer-input-panel',
    'aria-label': 'Needs your input',
    hidden: '',
  })
  const heading = el('div', { class: 'reviewer-input-heading' }, 'Needs your input')
  const close = el(
    'button',
    { type: 'button', class: 'reviewer-input-close', 'aria-label': 'Close' },
    '×',
  )
  const header = el('div', { class: 'reviewer-input-header' }, heading, close)
  const items = el('div', { class: 'reviewer-input-items' })
  panel.append(header, items)

  let expandedId: string | null = null
  let selectedOption = ''
  let draft = ''
  let threadId: string | null = null
  let signature = ''
  const closedThreads = new Set<string>()

  function open(requestId: string): void {
    const thread = getActiveThread(store)
    if (!thread) return
    closedThreads.delete(thread.id)
    expandedId = requestId
    selectedOption = ''
    draft = ''
    signature = ''
    sync()
  }

  function renderRow(request: ReviewerInputRequest, activeThreadId: string): HTMLElement {
    const row = el('div', { class: 'reviewer-input-item', 'data-reviewer-input-id': request.id })
    const answer = reviewerInputAnswer(getActiveThread(store)?.reviewerInputAnswers, request.id)
    const question = el(
      'button',
      {
        type: 'button',
        class: 'reviewer-input-question',
        'aria-expanded': String(expandedId === request.id),
      },
      request.question,
    )
    question.addEventListener('click', () => {
      expandedId = expandedId === request.id ? null : request.id
      selectedOption = ''
      draft = ''
      signature = ''
      sync()
    })
    row.append(question)

    if (expandedId === request.id) {
      row.append(el('p', { class: 'reviewer-input-context' }, request.context))
      if (request.recommendation) {
        row.append(
          el(
            'p',
            { class: 'reviewer-input-recommendation' },
            `Agent suggests: ${request.recommendation}`,
          ),
        )
      }
      if (answer) {
        row.append(el('div', { class: 'reviewer-input-answer' }, `Answered: ${answer.text}`))
      } else {
        const options = el('div', { class: 'reviewer-input-options' })
        const send = el('button', { type: 'button', class: 'ui-btn ui-btn-primary' }, 'Send answer')
        const input = el('textarea', {
          class: 'reviewer-input-text',
          rows: '2',
          'aria-label': 'Your answer or extra context',
          placeholder: 'Your answer or extra context…',
        })
        input.value = draft
        const updateSend = (): void => {
          send.disabled = answerText(selectedOption, input.value) === ''
        }
        for (const option of request.options) {
          const button = el(
            'button',
            {
              type: 'button',
              class: 'reviewer-input-option',
              'aria-pressed': String(selectedOption === option),
            },
            option,
          )
          button.addEventListener('click', () => {
            selectedOption = selectedOption === option ? '' : option
            for (const peer of options.querySelectorAll<HTMLButtonElement>('button')) {
              peer.setAttribute('aria-pressed', String(peer === button && selectedOption !== ''))
            }
            updateSend()
          })
          options.append(button)
        }
        input.addEventListener('input', () => {
          draft = input.value
          updateSend()
        })
        send.addEventListener('click', () => {
          const text = answerText(selectedOption, input.value)
          if (!answerReviewerInput(store, api, activeThreadId, request.id, text)) return
          expandedId = null
          selectedOption = ''
          draft = ''
          signature = ''
          sync()
        })
        updateSend()
        if (request.options.length) row.append(options)
        row.append(input, send)
      }
    }
    const origin = el(
      'button',
      { type: 'button', class: 'reviewer-input-origin' },
      'Show in conversation',
    )
    origin.addEventListener('click', () => {
      store.emit('reviewer_input_jump', request.messageId, request.id)
    })
    row.append(origin)
    return row
  }

  function sync(): void {
    const thread = getActiveThread(store)
    if (thread?.id !== threadId) {
      threadId = thread?.id ?? null
      expandedId = null
      selectedOption = ''
      draft = ''
      signature = ''
    }
    const requests = thread ? reviewerInputRequests(thread) : []
    const answers = thread?.reviewerInputAnswers
    const pending = requests.filter((request) => !reviewerInputAnswer(answers, request.id))
    const nextSignature = JSON.stringify({
      threadId,
      requests,
      answers,
      expandedId,
      closed: thread ? closedThreads.has(thread.id) : false,
    })
    if (nextSignature === signature) return
    signature = nextSignature
    toggle.hidden = requests.length === 0
    toggle.textContent = `${String(pending.length)} ${pending.length === 1 ? 'question' : 'questions'}`
    toggle.setAttribute('aria-expanded', String(requests.length > 0 && !panel.hidden))
    panel.hidden = !thread || requests.length === 0 || closedThreads.has(thread.id)
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
    items.replaceChildren(
      ...(thread ? requests.map((request) => renderRow(request, thread.id)) : []),
    )
  }

  toggle.addEventListener('click', () => {
    const thread = getActiveThread(store)
    if (!thread) return
    if (closedThreads.has(thread.id)) closedThreads.delete(thread.id)
    else closedThreads.add(thread.id)
    signature = ''
    sync()
  })
  close.addEventListener('click', () => {
    const thread = getActiveThread(store)
    if (!thread) return
    closedThreads.add(thread.id)
    signature = ''
    sync()
  })
  return { toggle, panel, sync, open }
}

/** The inline transcript anchor always survives panel close and thread reload. */
export function createReviewerInputToolCard(
  call: ToolCall,
  store: AppStore,
): HTMLDetailsElement | null {
  const request = parseReviewerInputCall(call, '')
  if (!request) return null
  const card = el('details', {
    class: 'tool-card reviewer-input-card',
    'data-tool-id': call.id,
    'data-status': 'done',
  })
  const answer = reviewerInputAnswer(getActiveThread(store)?.reviewerInputAnswers, call.id)
  card.append(
    el(
      'summary',
      { class: 'tool-card-header' },
      answer ? 'Answered' : 'Needs your input',
      ' · ',
      request.question,
    ),
    el('p', { class: 'reviewer-input-card-context' }, request.context),
  )
  if (answer)
    card.append(el('p', { class: 'reviewer-input-card-answer' }, `Your answer: ${answer.text}`))
  else {
    const open = el('button', { type: 'button', class: 'reviewer-input-origin' }, 'Answer question')
    open.addEventListener('click', () => {
      store.emit('reviewer_input_open', request.id)
    })
    card.append(open)
  }
  return card
}
