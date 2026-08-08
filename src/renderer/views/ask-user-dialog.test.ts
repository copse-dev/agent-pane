// Verifies the ask_user dialog: it mounts as a native <dialog>, renders the
// agent's questions (with optional quick-pick option buttons), and on submit
// returns one answer per question via api.ask.respond — the value the blocked
// agent loop awaits.
//
// happy-dom has no modal-dialog implementation (no showModal/close/open), so we
// shim those to track open state — the same approach as the file-search and
// settings dialog tests. Real top-layer behaviour is covered by Chromium e2e.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore, type AppStore } from '@shared/store/store.ts'
import { mountAskUserDialog } from './ask-user-dialog.ts'
import { isThreadAwaitingAttention, resetAttention } from '../controller/attention.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

interface AskUserRequest {
  id: string
  threadId?: string
  questions: { question: string; options?: string[] }[]
}

interface Harness {
  emit: (req: AskUserRequest) => void
  responses: { id: string; answers: string[] }[]
}

// Capture the request listener so a test can drive a request through, and record
// every ask.respond call so we can assert the answers handed back.
function stubApi(): { api: ApiClient; harness: Harness } {
  let listener: ((req: AskUserRequest) => void) | null = null
  const responses: { id: string; answers: string[] }[] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      onAskUserRequest: (handler: (req: AskUserRequest) => void): (() => void) => {
        listener = handler
        return (): void => {}
      },
    },
    ask: {
      ...base.ask,
      respond: (id: string, answers: string[]): Promise<void> => {
        responses.push({ id, answers })
        return Promise.resolve()
      },
    },
  }
  const harness: Harness = {
    emit: (req) => {
      if (!listener) throw new Error('no ask_user listener registered')
      listener({
        id: req.id,
        questions: req.questions,
        ...(req.threadId === undefined ? {} : { threadId: req.threadId }),
      })
    },
    responses,
  }
  return { api, harness }
}

function shimModal(el: HTMLDialogElement): void {
  let open = false
  Object.defineProperties(el, {
    showModal: { configurable: true, value: () => void (open = true) },
    close: { configurable: true, value: () => void (open = false) },
    open: { configurable: true, get: () => open },
  })
}

function dialog(): HTMLDialogElement {
  const found = document.querySelector<HTMLDialogElement>('#ask-user-dialog')
  if (!found) throw new Error('ask-user dialog not mounted')
  return found
}

// Mount the dialog and shim its modal methods before any request opens it.
// Requests here carry no threadId, so they show regardless of the (empty) store
// focus — the thread-scoping path has its own dedicated spec.
function mount(api: ApiClient): void {
  mountAskUserDialog(api, createStore())
  shimModal(dialog())
}

function inputs(): HTMLTextAreaElement[] {
  return Array.from(document.querySelectorAll<HTMLTextAreaElement>('.ask-user-input'))
}

function at<T>(list: ArrayLike<T>, i: number): T {
  const value = list[i]
  if (value === undefined) throw new Error(`expected element at index ${String(i)}`)
  return value
}

function submitForm(): void {
  const form = document.querySelector<HTMLFormElement>('#ask-user-form')
  if (!form) throw new Error('ask-user form not mounted')
  form.requestSubmit()
}

describe('ask_user dialog (component)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    resetAttention()
    // modal methods are shimmed per-mount via mount()
  })

  it('renders a question and returns the typed answer on submit', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit({ id: 'q1', questions: [{ question: 'Which DB?' }] })

    assert.equal(dialog().open, true)
    assert.equal(document.querySelector('.ask-user-question')?.textContent, 'Which DB?')

    const input = at(inputs(), 0)
    input.value = 'Postgres'
    submitForm()

    assert.deepEqual(harness.responses, [{ id: 'q1', answers: ['Postgres'] }])
    assert.equal(dialog().open, false)
  })

  it('fills the input when a suggested option is clicked', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit({
      id: 'q2',
      questions: [{ question: 'Which DB?', options: ['Postgres', 'SQLite'] }],
    })

    const optionButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.ask-user-option'),
    )
    assert.equal(optionButtons.length, 2)
    at(optionButtons, 1).click()

    assert.equal(at(inputs(), 0).value, 'SQLite')

    submitForm()
    assert.deepEqual(harness.responses, [{ id: 'q2', answers: ['SQLite'] }])
  })

  it('renders commands as sanitized Markdown in questions and quick picks', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit({
      id: 'q-markdown',
      questions: [
        {
          question: 'Run `claude /login`, then try again.',
          options: ['Run `claude /login`'],
        },
      ],
    })

    const question = document.querySelector<HTMLElement>('.ask-user-question')
    const option = document.querySelector<HTMLButtonElement>('.ask-user-option')
    assert.ok(question)
    assert.ok(option)
    assert.equal(question.querySelector('code')?.textContent, 'claude /login')
    assert.equal(question.textContent.includes('`'), false)
    assert.equal(option.querySelector('code')?.textContent, 'claude /login')
    assert.equal(option.textContent.includes('`'), false)
    option.click()
    assert.equal(at(inputs(), 0).value, 'Run claude /login')
  })

  it('collects one answer per question for a multi-question ask', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit({
      id: 'q3',
      questions: [{ question: 'Which DB?' }, { question: 'Async?' }],
    })

    const fields = inputs()
    assert.equal(fields.length, 2)
    at(fields, 0).value = 'Postgres'
    at(fields, 1).value = 'Yes'
    submitForm()

    assert.deepEqual(harness.responses, [{ id: 'q3', answers: ['Postgres', 'Yes'] }])
  })

  it('returns blank answers when the user cancels', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit({
      id: 'q-cancel',
      questions: [{ question: 'Which DB?' }, { question: 'Async?' }],
    })

    const cancelBtn = document.querySelector<HTMLButtonElement>('.ask-user-cancel')
    if (!cancelBtn) throw new Error('cancel button not found')
    cancelBtn.click()

    assert.deepEqual(harness.responses, [{ id: 'q-cancel', answers: ['', ''] }])
    assert.equal(dialog().open, false)
  })

  it('queues a second request and shows it after the first is answered', () => {
    const { api, harness } = stubApi()
    mount(api)
    harness.emit({ id: 'a', questions: [{ question: 'First?' }] })
    harness.emit({ id: 'b', questions: [{ question: 'Second?' }] })

    // Only the first is on screen.
    assert.equal(document.querySelector('.ask-user-question')?.textContent, 'First?')
    at(inputs(), 0).value = '1'
    submitForm()

    // The second now shows and binds answers to its own id.
    assert.equal(document.querySelector('.ask-user-question')?.textContent, 'Second?')
    at(inputs(), 0).value = '2'
    submitForm()

    assert.deepEqual(harness.responses, [
      { id: 'a', answers: ['1'] },
      { id: 'b', answers: ['2'] },
    ])
  })
})

// A question belongs to the thread whose run asked it. The dialog is modal, so
// one left hanging over a thread the user has moved to — including via a project
// switch, which swaps activeThreadId the same way — blocks the window on a
// question that thread never asked.
describe('ask_user dialog thread scoping', () => {
  let store: AppStore

  function mountScoped(api: ApiClient): void {
    store = createStore({ activeThreadId: 'focused' })
    mountAskUserDialog(api, store)
    shimModal(dialog())
  }

  function focusThread(threadId: string): void {
    store.setState({ activeThreadId: threadId })
    store.emit('threads_changed')
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    resetAttention()
  })

  it('withdraws the open question when the user switches away from its thread', () => {
    const { api, harness } = stubApi()
    mountScoped(api)
    harness.emit({ id: 'q', threadId: 'focused', questions: [{ question: 'Which DB?' }] })
    assert.equal(dialog().open, true)

    focusThread('other')

    assert.equal(dialog().open, false)
    // Withdrawn, not answered — the agent is still waiting.
    assert.deepEqual(harness.responses, [])
    assert.equal(isThreadAwaitingAttention('focused'), true)
  })

  it('brings a withdrawn question back when its thread is focused again', () => {
    const { api, harness } = stubApi()
    mountScoped(api)
    harness.emit({ id: 'q', threadId: 'focused', questions: [{ question: 'Which DB?' }] })
    focusThread('other')

    focusThread('focused')

    assert.equal(dialog().open, true)
    assert.equal(isThreadAwaitingAttention('focused'), false)
    at(inputs(), 0).value = 'Postgres'
    submitForm()
    assert.deepEqual(harness.responses, [{ id: 'q', answers: ['Postgres'] }])
  })

  it('swaps in the newly-focused thread’s question on a switch', () => {
    const { api, harness } = stubApi()
    mountScoped(api)
    harness.emit({ id: 'q-focused', threadId: 'focused', questions: [{ question: 'First?' }] })
    harness.emit({ id: 'q-other', threadId: 'other', questions: [{ question: 'Second?' }] })
    assert.equal(document.querySelector('.ask-user-question')?.textContent, 'First?')

    focusThread('other')

    assert.equal(dialog().open, true)
    assert.equal(document.querySelector('.ask-user-question')?.textContent, 'Second?')
    at(inputs(), 0).value = '2'
    submitForm()
    assert.deepEqual(harness.responses, [{ id: 'q-other', answers: ['2'] }])
  })
})
