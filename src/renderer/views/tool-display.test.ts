import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  setMessageToolSummary,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'

// Component-level port of tests/e2e/tool-display-rollup.e2e.ts. The grouping /
// tense / turn-rollup LOGIC is covered in src/shared/tools/tool-display.test.ts;
// this file asserts the conversation VIEW: one collapsed `.tool-card-rollup`,
// nested "Read files ×2", and the failed read as its own card outside that
// group. Seeded thread mirrors seedToolDisplayFixture().

function fakeApi(): ApiClient {
  return {
    agent: { run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } as unknown as ApiClient
}

// Mount the real conversation view over a thread holding one assistant message
// with the three seeded tool calls. The message text is left empty on purpose:
// the e2e never asserted it, and an empty assistant body skips the markdown /
// file-annotation path so the test stays focused on tool-card rendering.
function mountWithTools(): {
  store: ReturnType<typeof createStore>
  threadId: string
  messageId: string
} {
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
  // Mirror seedToolDisplayFixture: polished summary already on the message.
  setMessageToolSummary(store, messageId, 'Inspected the repo layout')
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  return { store, threadId, messageId }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('tool call display (component)', () => {
  it('rolls the turn into one collapsed italic summary with polished wording', () => {
    mountWithTools()

    const rollup = document.querySelector('.tool-card-rollup')
    assert.ok(rollup, 'expected a turn rollup card')
    // Collapsed by default once settled; expand to inspect nested groups.
    assert.equal(rollup.hasAttribute('open'), false)
    // toolSummary polish + failure callout (not the canned "Used 3 tools").
    assert.equal(
      rollup.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
      'Inspected the repo layout · 1 failed',
    )
  })

  it('keeps the successful reads grouped inside the rollup and surfaces the error outside that group', () => {
    mountWithTools()

    const rollup = document.querySelector('.tool-card-rollup') as HTMLDetailsElement
    assert.ok(rollup)
    rollup.open = true

    const group = rollup.querySelector('.tool-card-group')
    assert.ok(group, 'expected a grouped tool card inside the rollup')
    assert.equal(group.querySelector('.tool-name')?.textContent, 'Read files')
    assert.equal(group.querySelector('.tool-count')?.textContent, '×2')

    const failed = rollup.querySelector('.tool-card[data-tool-id="tc-read-2"]')
    assert.ok(failed, 'expected the errored read to render as an individual card')
    assert.equal(failed.querySelector('.tool-name')?.textContent, 'Read file')
    assert.equal(failed.getAttribute('data-status'), 'error')
    // The errored read must NOT be folded into the reading group.
    assert.equal(document.querySelector('.tool-card-group [data-tool-id="tc-read-2"]'), null)
  })

  it('keeps a user-expanded group item open across a tool update rebuild', () => {
    const { store, messageId } = mountWithTools()

    const rollup = document.querySelector('.tool-card-rollup') as HTMLDetailsElement
    const group = rollup.querySelector('.tool-card-group') as HTMLDetailsElement
    const item = group.querySelector('[data-tool-id="tc-read-1"]') as HTMLDetailsElement
    rollup.open = true
    group.open = true
    item.open = true

    // A group member changing rebuilds the whole group card from scratch (its
    // signature covers every member); the expanded item must survive — it used
    // to snap shut on every agent step.
    updateToolCall(store, messageId, 'tc-list-1', { result: 'd main\nf index.ts\nf util.ts' })

    const rollups = document.querySelectorAll('.tool-card-rollup')
    assert.equal(rollups.length, 1, 'rebuild must replace the rollup, not duplicate it')
    const rollupAfter = rollups[0] as HTMLDetailsElement
    assert.equal(rollupAfter.hasAttribute('open'), true, 'rollup should stay open')
    const groups = rollupAfter.querySelectorAll('.tool-card-group')
    assert.equal(groups.length, 1, 'rebuild must replace the group card, not duplicate it')
    const groupAfter = groups[0] as HTMLDetailsElement
    assert.ok(groupAfter, 'expected the group card to still render')
    assert.equal(groupAfter.hasAttribute('open'), true, 'group should stay open')
    const itemAfter = groupAfter.querySelector('[data-tool-id="tc-read-1"]')
    assert.ok(itemAfter, 'expected the reading item to still render')
    assert.equal(itemAfter.hasAttribute('open'), true, 'expanded item should stay open')
    // The item the user never touched stays collapsed.
    assert.equal(
      groupAfter.querySelector('[data-tool-id="tc-list-1"]')?.hasAttribute('open'),
      false,
    )
  })

  it('renders the advisor result as attributed markdown, not raw text', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      id: 'tc-advisor',
      name: 'advisor',
      args: {},
      status: 'done',
      resultFormat: 'markdown',
      result:
        '**Advisor — claude-opus-4-8**\n\n**Key risk:** the diff is large.\n\n- ship the smallest slice',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = document.querySelector('.tool-card[data-tool-id="tc-advisor"]')
    assert.ok(card, 'expected an advisor tool card')
    const resultEl = card.querySelector('.tool-result')
    assert.ok(resultEl, 'expected a tool-result section')
    assert.ok(resultEl.classList.contains('tool-result-markdown'))
    // The advisor model is named (so its output is distinct from the executor's),
    // and the bold/list markdown renders instead of literal ** and - markers.
    assert.ok(resultEl.querySelector('strong'), 'expected rendered bold, not literal **')
    assert.ok(resultEl.querySelector('li'), 'expected a rendered list item')
    assert.ok(resultEl.textContent.includes('claude-opus-4-8'))
    assert.equal(resultEl.textContent.includes('**Advisor'), false)
  })

  it('renders an ACP markdown result as markdown, not literal code fences', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      id: 'tc-acp-term',
      name: 'Terminal',
      args: {},
      status: 'done',
      kind: 'execute',
      resultFormat: 'markdown',
      result: '```console\n(Bash completed with no output)\n```',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const card = document.querySelector('.tool-card[data-tool-id="tc-acp-term"]')
    assert.ok(card, 'expected the ACP tool call to render a card')
    const resultEl = card.querySelector('.tool-result')
    assert.ok(resultEl, 'expected a tool-result section')
    // The fence must become a real code element, not literal backticks.
    assert.ok(resultEl.classList.contains('tool-result-markdown'))
    assert.ok(resultEl.querySelector('code'), 'expected a rendered code element')
    assert.equal(resultEl.textContent.includes('```'), false)
    assert.ok(resultEl.textContent.includes('(Bash completed with no output)'))
  })
})
