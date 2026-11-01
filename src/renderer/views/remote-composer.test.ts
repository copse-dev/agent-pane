import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import { mountRemoteComposer, type ChatTransport } from './remote-composer.ts'

// The shared DOM harness does not copy happy-dom's ResizeObserver to globalThis.
class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
})

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

interface Harness {
  root: HTMLElement
  store: ReturnType<typeof createStore>
  threadId: string
  editor: HTMLElement
  submit: HTMLButtonElement
  setText(text: string): void
  setConnected(value: boolean): void
  dispose(): void
}

function harness(send: ChatTransport['send']): Harness {
  const store = createStore({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Prepare the mobile release.')
  addMessage(store, threadId, 'assistant', 'The shared chat is ready.')
  const api = createFakeApi()
  api.agent.suggestNextStep = (): Promise<string | null> =>
    Promise.resolve('Test reconnect on my phone.')
  let connected = true
  const root = document.createElement('div')
  document.body.append(root)
  const mount = mountRemoteComposer(root, store, api, {
    send,
    stop: () => Promise.resolve(),
    connected: () => connected,
  })
  const editor = qsRequired(root, '.prompt-input')
  const submit = qsRequired<HTMLButtonElement>(root, '.submit-btn')
  return {
    root,
    store,
    threadId,
    editor,
    submit,
    setText(text: string): void {
      editor.textContent = text
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    },
    setConnected(value: boolean): void {
      connected = value
      store.emit('threads_changed')
    },
    dispose(): void {
      mount.unmount()
      root.remove()
    },
  }
}

describe('shared remote composer', () => {
  it('inserts a suggestion for editing and sends only the edited prompt once', async () => {
    const sent: string[] = []
    const h = harness((_project, _thread, text) => {
      sent.push(text)
      return Promise.resolve()
    })
    try {
      h.store.emit('threads_changed')
      await flush()
      qsRequired<HTMLButtonElement>(h.root, '.remote-next-step').click()
      assert.equal(h.editor.textContent, 'Test reconnect on my phone.')
      assert.deepEqual(sent, [])
      h.setText('Test reconnect on my phone, including a saved draft.')
      h.submit.click()
      h.submit.click()
      await flush()
      assert.deepEqual(sent, ['Test reconnect on my phone, including a saved draft.'])
      assert.equal(h.editor.textContent, '')
    } finally {
      h.dispose()
    }
  })

  it('retains a draft on uncertain delivery and through disconnection', async () => {
    const h = harness(() => Promise.reject(new Error('Connection lost before confirmation.')))
    try {
      h.setText('Keep this next prompt.')
      h.submit.click()
      await flush()
      assert.equal(h.editor.textContent, 'Keep this next prompt.')
      assert.equal(
        qsRequired(h.root, '[role="alert"]').textContent,
        'Connection lost before confirmation.',
      )
      h.setConnected(false)
      assert.equal(h.submit.disabled, true)
      assert.equal(h.editor.textContent, 'Keep this next prompt.')
      h.setConnected(true)
      assert.equal(h.submit.disabled, false)
      assert.equal(h.editor.textContent, 'Keep this next prompt.')
    } finally {
      h.dispose()
    }
  })

  it('preserves a newer draft entered while an earlier submission is in flight', async () => {
    let complete = (): void => {
      throw new Error('Submission has not started')
    }
    const h = harness(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    try {
      h.setText('First prompt')
      h.submit.click()
      assert.equal(h.submit.disabled, true)
      h.setText('My next prompt')
      complete()
      await flush()
      assert.equal(h.editor.textContent, 'My next prompt')
      assert.equal(h.submit.disabled, false)
    } finally {
      h.dispose()
    }
  })
})
