import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, addToolCall, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

const APPLY_PATCH_CARD_INPUT = [
  '*** Begin Patch',
  '*** Update File: src/app.ts',
  '@@ function start()',
  ' keep',
  '-old',
  '+new',
  '+extra',
  '*** Add File: src/new.ts',
  '+one',
  '+two',
  '*** Update File: src/old-name.ts',
  '*** Move to: src/new-name.ts',
  '-a',
  '+b',
  '*** Delete File: src/gone.ts',
  '*** End Patch',
].join('\n')

function fakeApi(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: { ...base['agent'], run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } satisfies ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('apply_patch tool card', () => {
  it('lists each file in the patch with its operation and line counts', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      id: 'patch-1',
      name: 'apply_patch',
      args: { input: APPLY_PATCH_CARD_INPUT },
      status: 'done',
      result: 'apply_patch handled 4 files:\n- Diff staged for src/app.ts.',
      editStats: { additions: 6, deletions: 3 },
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = host.querySelector<HTMLDetailsElement>('.tool-card')
    assert.ok(card)
    // A header click builds the lazily-rendered body before the browser opens it.
    card.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    assert.equal(card.querySelector('.tool-name')?.textContent, 'Patched 4 files')
    const rows = [...card.querySelectorAll<HTMLElement>('.tool-patch-file')]
    assert.deepEqual(
      rows.map((row) => [
        row.dataset['op'],
        row.dataset['editPath'],
        row.querySelector('.tool-patch-op')?.textContent,
        row.querySelector('.tool-stat-add')?.textContent,
        row.querySelector('.tool-stat-del')?.textContent,
      ]),
      [
        ['update', 'src/app.ts', 'Edited', '+2', '-1'],
        ['add', 'src/new.ts', 'Added', '+2', '-0'],
        ['move', 'src/new-name.ts', 'Moved', '+1', '-1'],
        ['delete', 'src/gone.ts', 'Deleted', undefined, undefined],
      ],
    )
    assert.equal(
      card.querySelector('.tool-patch-file[data-op="move"] .tool-patch-path')?.textContent,
      'src/old-name.ts → src/new-name.ts',
    )
  })
})
