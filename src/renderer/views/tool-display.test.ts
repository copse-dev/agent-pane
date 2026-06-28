import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, addToolCall, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// Component-level port of tests/e2e/tool-display.e2e.ts. The grouping LOGIC
// (which tool calls fold into a "Reading files" group, the human-readable
// labels) is already covered in src/shared/tools/tool-display.test.ts; what the
// e2e uniquely exercised is the conversation VIEW rendering of that logic — the
// collapsed group card with its ×2 count, and the failed tool surfaced as its
// own card outside the group. That render is pure DOM/structure (no geometry),
// so it ports cleanly to happy-dom. The seeded thread mirrors
// seedToolDisplayFixture(): two successful reads (read_file + list_dir → the
// "reading" group) plus one errored read_file.

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } as unknown as ApiClient
}

// Mount the real conversation view over a thread holding one assistant message
// with the three seeded tool calls. The message text is left empty on purpose:
// the e2e never asserted it, and an empty assistant body skips the markdown /
// file-annotation path so the test stays focused on tool-card rendering.
function mountWithTools() {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'assistant', '')
  addToolCall(store, messageId, {
    id: 'tc-read-1',
    name: 'read_file',
    args: { path: 'README.md' },
    status: 'done',
    result: '# Copse\n',
  })
  addToolCall(store, messageId, {
    id: 'tc-list-1',
    name: 'list_dir',
    args: { path: 'src' },
    status: 'done',
    result: 'd main\nf index.ts',
  })
  addToolCall(store, messageId, {
    id: 'tc-read-2',
    name: 'read_file',
    args: { path: 'missing.txt' },
    status: 'error',
    result: 'Error: ENOENT',
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  return { store, threadId, messageId }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('tool call display (component)', () => {
  it('groups the successful reads into one collapsed card with a ×2 count', () => {
    mountWithTools()

    const group = document.querySelector('.tool-card-group')
    assert.ok(group, 'expected a grouped tool card')
    // e2e: groupCard not to have attribute 'open' (collapsed by default)
    assert.equal(group.hasAttribute('open'), false)
    // e2e: group .tool-name === 'Reading files', .tool-count === '×2'
    assert.equal(group.querySelector('.tool-name')?.textContent, 'Reading files')
    assert.equal(group.querySelector('.tool-count')?.textContent, '×2')
  })

  it('renders the failed read as its own card outside the group, with error status', () => {
    mountWithTools()

    const failed = document.querySelector('.tool-card[data-tool-id="tc-read-2"]')
    assert.ok(failed, 'expected the errored read to render as an individual card')
    // e2e: failed .tool-name === 'Read file', data-status === 'error'
    assert.equal(failed.querySelector('.tool-name')?.textContent, 'Read file')
    assert.equal(failed.getAttribute('data-status'), 'error')
    // The errored read must NOT be folded into the reading group.
    assert.equal(document.querySelector('.tool-card-group [data-tool-id="tc-read-2"]'), null)
  })
})
