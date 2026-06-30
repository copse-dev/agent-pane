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
import { mountAskUserDialog } from './ask-user-dialog.ts'

interface AskUserRequest {
  id: string
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
  const api = {
    agent: {
      onAskUserRequest: (handler: (req: AskUserRequest) => void): (() => void) => {
        listener = handler
        return (): void => {}
      },
    },
    ask: {
      respond: (id: string, answers: string[]): Promise<void> => {
        responses.push({ id, answers })
        return Promise.resolve()
      },
    },
  }
  const harness: Harness = {
    emit: (req) => {
      if (!listener) throw new Error('no ask_user listener registered')
      listener(req)
    },
    responses,
  }
  return { api: api as unknown as ApiClient, harness }
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
function mount(api: ApiClient): void {
  mountAskUserDialog(api)
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
