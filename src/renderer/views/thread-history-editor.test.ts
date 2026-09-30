import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, before, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import type {
  ThreadHistoryEditRequest,
  ThreadHistoryEditResult,
  ThreadHistorySnapshot,
} from '@shared/threads/history-edit.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { openThreadHistoryEditor } from './thread-history-editor.ts'

const messages: Message[] = [
  { id: 'u1', role: 'user', content: 'Use PostgreSQL', toolCalls: [], createdAt: 1 },
  { id: 'a1', role: 'assistant', content: 'I will use PostgreSQL.', toolCalls: [], createdAt: 2 },
  { id: 'u2', role: 'user', content: 'Actually use SQLite', toolCalls: [], createdAt: 3 },
]

function thread(nextMessages: Message[] = messages): Thread {
  return {
    id: 'thread-1',
    title: 'Database migration',
    status: 'idle',
    messages: nextMessages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 3,
  }
}

function snapshot(overrides: Partial<ThreadHistorySnapshot> = {}): ThreadHistorySnapshot {
  return {
    revision: 'a'.repeat(64),
    title: 'Database migration',
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      included: true,
      hasToolCalls: false,
    })),
    canUndo: false,
    ...overrides,
  }
}

before(() => {
  Object.defineProperties(window.HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        if (!this.open) return
        this.open = false
        this.dispatchEvent(new window.Event('close'))
      },
    },
  })
})

afterEach(() => {
  document.body.replaceChildren()
})

function apiFor(
  source: ThreadHistorySnapshot,
  onEdit: (request: ThreadHistoryEditRequest) => void = (): void => undefined,
): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    threads: {
      ...base.threads,
      historySnapshot: async (): Promise<ThreadHistorySnapshot> => source,
      editHistory: async (_projectId, _threadId, request): Promise<ThreadHistoryEditResult> => {
        onEdit(request)
        const nextMessages = messages.flatMap((message) => {
          const edit = request.messages.find((item) => item.id === message.id)
          return edit?.included ? [{ ...message, content: edit.content }] : []
        })
        return {
          thread: thread(nextMessages),
          revision: 'b'.repeat(64),
          canUndo: true,
        }
      },
      undoHistoryEdit: async (): Promise<ThreadHistoryEditResult> => ({
        thread: thread(),
        revision: 'a'.repeat(64),
        canUndo: false,
      }),
    },
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('thread history editor', () => {
  it('edits and excludes messages, then replaces the in-memory thread', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })
    let request: ThreadHistoryEditRequest | undefined
    openThreadHistoryEditor(
      store,
      apiFor(snapshot(), (next) => (request = next)),
      {
        projectId: 'project-1',
        threadId: 'thread-1',
      },
    )
    await settle()

    const inputs = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('.history-editor-message-input'),
    )
    assert.equal(inputs.length, 3)
    const firstInput = inputs[0]
    assert(firstInput)
    firstInput.value = 'Use SQLite'
    firstInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    const includes = Array.from(
      document.querySelectorAll<HTMLInputElement>('.history-editor-include'),
    )
    const thirdInclude = includes[2]
    assert(thirdInclude)
    thirdInclude.click()

    const apply = document.querySelector<HTMLButtonElement>(
      '.history-editor-actions .ui-btn-primary',
    )
    assert.ok(apply)
    assert.equal(apply.disabled, false)
    apply.click()
    await settle()

    assert(request)
    assert.equal(request.expectedRevision, 'a'.repeat(64))
    assert.equal(request.messages[0]?.content, 'Use SQLite')
    assert.equal(request.messages[2]?.included, false)
    assert.deepEqual(
      store.getState().threads[0]?.messages.map((message) => message.content),
      ['Use SQLite', 'I will use PostgreSQL.'],
    )
    assert.equal(document.querySelector<HTMLButtonElement>('.history-editor-undo')?.hidden, false)
  })

  it('surfaces unrecoverable context and disables Apply', async () => {
    const store = createStore({ activeProjectId: 'project-1', threads: [thread()] })
    const blocked = snapshot({ blockedReason: 'Attachment context cannot be reconstructed.' })
    const firstBlockedMessage = blocked.messages[0]
    assert(firstBlockedMessage)
    blocked.messages[0] = {
      ...firstBlockedMessage,
      reconstructionWarning: 'Attachment context cannot be reconstructed.',
    }
    openThreadHistoryEditor(store, apiFor(blocked), {
      projectId: 'project-1',
      threadId: 'thread-1',
    })
    await settle()

    assert.match(
      document.querySelector('.history-editor-warning')?.textContent ?? '',
      /cannot be reconstructed/,
    )
    const first = document.querySelector<HTMLTextAreaElement>('.history-editor-message-input')
    assert.ok(first)
    first.value = 'Changed'
    first.dispatchEvent(new window.Event('input', { bubbles: true }))
    assert.equal(
      document.querySelector<HTMLButtonElement>('.history-editor-actions .ui-btn-primary')
        ?.disabled,
      true,
    )

    document.querySelector<HTMLInputElement>('.history-editor-include')?.click()
    assert.equal(
      document.querySelector<HTMLButtonElement>('.history-editor-actions .ui-btn-primary')
        ?.disabled,
      false,
    )
  })
})
