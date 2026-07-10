import '../../../tests/setup-dom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ThreadCatalogHit } from '@shared/types'
import { initMentionPicker, type AttachedThreadRef } from './mention-picker.ts'
import type { ComposerTextInput } from './composer-editor.ts'

// The picker depends only on the textarea-shaped ComposerTextInput slice, so a
// plain textarea behind that interface keeps this test focused on picker logic
// (the real composer editor has its own unit + e2e coverage).
function asTextInput(textarea: HTMLTextAreaElement): ComposerTextInput {
  return {
    el: textarea,
    get value(): string {
      return textarea.value
    },
    set value(v: string) {
      textarea.value = v
    },
    get selectionStart(): number {
      return textarea.selectionStart
    },
    setSelectionRange: (start, end): void => {
      textarea.setSelectionRange(start, end)
    },
    focus: (): void => {
      textarea.focus()
    },
  }
}

function hit(id: string, title: string, updatedAt = Date.now()): ThreadCatalogHit {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt,
    digest: title,
    path: id,
    spinePath: `/chat/proj/${id}/events.jsonl`,
  }
}

function fakeApi(threads: ThreadCatalogHit[], files: string[]): ApiClient {
  return {
    threads: { catalog: async (): Promise<ThreadCatalogHit[]> => threads },
    index: { query: async (): Promise<string[]> => files },
    fs: { readFile: async (): Promise<string> => 'file body' },
  } as unknown as ApiClient
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
}

async function typeMention(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  textarea.value = text
  textarea.selectionStart = text.length
  textarea.selectionEnd = text.length
  textarea.dispatchEvent(new Event('input'))
  await flush()
}

describe('mention picker (files + threads, #644)', () => {
  let dispose: (() => void) | undefined
  let inputBar: HTMLElement = document.createElement('div')

  afterEach(() => {
    dispose?.()
    dispose = undefined
    inputBar.remove()
  })

  function mount(
    threads: ThreadCatalogHit[],
    files: string[],
    onAttachThread: (t: AttachedThreadRef) => void = () => {},
  ): HTMLTextAreaElement {
    const store = createStore({
      activeProjectId: 'p1',
      activeThreadId: 'active',
      threads: [],
      projects: [],
    })
    inputBar = document.createElement('div')
    const textarea = document.createElement('textarea')
    inputBar.append(textarea)
    document.body.append(inputBar)
    dispose = initMentionPicker({
      input: asTextInput(textarea),
      inputBar,
      store,
      api: fakeApi(threads, files),
      onAttach: () => {},
      onAttachThread,
    })
    return textarea
  }

  it('lists past threads above files and excludes the active thread', async () => {
    const textarea = mount([hit('t1', 'Auth refactor'), hit('active', 'Current')], ['src/a.ts'])
    await typeMention(textarea, '@ref')

    const picker = inputBar.querySelector('.mention-picker')
    assert.ok(picker)
    const items = picker.querySelectorAll('.mention-item')
    assert.equal(items.length, 2)
    const threadRow = items[0]
    const fileRow = items[1]
    assert.ok(threadRow)
    assert.ok(fileRow)
    assert.ok(threadRow.classList.contains('mention-item-thread'))
    assert.match(threadRow.textContent, /Auth refactor/)
    assert.equal(fileRow.textContent, 'src/a.ts')
    // The active thread is never offered as a reference.
    assert.doesNotMatch(picker.textContent, /Current/)
  })

  it('selecting a thread attaches its id, title, and absolute spine path', async () => {
    const attached: AttachedThreadRef[] = []
    const textarea = mount([hit('t1', 'Auth refactor')], ['src/a.ts'], (t) => attached.push(t))
    await typeMention(textarea, '@ref')

    const first = inputBar.querySelector('.mention-picker .mention-item')
    assert.ok(first)
    first.dispatchEvent(new Event('mousedown'))
    await flush()

    assert.equal(attached.length, 1)
    const ref = attached[0]
    assert.ok(ref)
    assert.equal(ref.threadId, 't1')
    assert.equal(ref.title, 'Auth refactor')
    assert.equal(ref.spinePath, '/chat/proj/t1/events.jsonl')
    // The mention text (`@ref`) is stripped from the composer after selection.
    assert.doesNotMatch(textarea.value, /@ref/)
  })
})
