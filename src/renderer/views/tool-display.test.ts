import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  setMessageToolSummary,
  setMessageCommandSummary,
  setThreadStatus,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// Component-level port of tests/e2e/tool-display-rollup.e2e.ts. The grouping /
// tense / turn-rollup LOGIC is covered in src/shared/tools/tool-display.test.ts;
// this file asserts the conversation VIEW: one collapsed `.tool-card-rollup`,
// flat successful tool rows, and the failed read visible outside the rollup.
// Seeded thread mirrors seedToolDisplayFixture().

function fakeApi(): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
    } satisfies ApiClient
  })()
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
  // Mirror seedToolDisplayFixture: polished summary + reasoning on the segment.
  setMessageToolSummary(store, messageId, 'Inspected the repo layout')
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const msg = thread?.messages.find((m) => m.id === messageId)
  if (msg) {
    msg.reasoning = 'Reading key files to diagnose the settings flicker.'
  }
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  return { store, threadId, messageId }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('tool call display (component)', () => {
  it('keeps legacy command summaries on the flat shell rollup', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    for (const id of ['shell-one', 'shell-two']) {
      addToolCall(store, messageId, {
        id,
        name: 'run_shell',
        args: { command: 'pnpm test' },
        status: 'done',
        result: 'passed',
      })
    }
    setMessageCommandSummary(store, messageId, 'Verified the build')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())
    assert.equal(qsRequired(host, '.tool-card-rollup .tool-name').textContent, 'Verified the build')
    assert.equal(host.querySelector('.tool-card-group'), null)
  })

  it('keeps fast tools compact instead of flashing their details open', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())
    setThreadStatus(store, threadId, 'running')

    addToolCall(store, messageId, {
      id: 'tc-fast',
      name: 'read_file',
      args: { path: 'README.md' },
      status: 'running',
      result: null,
    })
    const rollup = document.querySelector<HTMLDetailsElement>('.tool-card-rollup')
    assert.ok(rollup, 'live work should use a stable rollup from the first tool')
    assert.equal(rollup.open, false)

    updateToolCall(store, messageId, 'tc-fast', {
      status: 'done',
      result: '# Copse',
    })
    await delay(350)
    assert.equal(rollup.open, false, 'a tool that finished inside the reveal delay flashed open')
  })

  it('keeps long-running background work compact through tool gaps', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())
    setThreadStatus(store, threadId, 'running')

    addToolCall(store, messageId, {
      id: 'tc-long',
      name: 'run_shell',
      args: { command: 'npm test' },
      status: 'running',
      result: null,
    })
    const rollup = document.querySelector<HTMLDetailsElement>('.tool-card-rollup')
    assert.ok(rollup)
    await delay(350)
    assert.equal(rollup.open, false, 'background work must stay collapsed')

    updateToolCall(store, messageId, 'tc-long', {
      status: 'done',
      result: 'passed',
    })
    assert.equal(rollup.open, false, 'tool completion must not open the rollup')
    addToolCall(store, messageId, {
      id: 'tc-next',
      name: 'read_file',
      args: { path: 'package.json' },
      status: 'running',
      result: null,
    })
    assert.strictEqual(
      document.querySelector('.tool-card-rollup'),
      rollup,
      'adding a second tool replaced the live rollup shell',
    )
    assert.equal(rollup.open, false)

    updateToolCall(store, messageId, 'tc-next', {
      status: 'done',
      result: '{}',
    })
    setThreadStatus(store, threadId, 'idle')
    await delay(1_100)
    assert.equal(rollup.open, false, 'settled work did not compact after its minimum dwell')
  })

  it('retains an explicit user-close while more tools arrive', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())
    setThreadStatus(store, threadId, 'running')
    addToolCall(store, messageId, {
      id: 'tc-running',
      name: 'run_shell',
      args: { command: 'npm test' },
      status: 'running',
      result: null,
    })
    const rollup = document.querySelector<HTMLDetailsElement>('.tool-card-rollup')
    assert.ok(rollup)
    await delay(350)
    assert.equal(rollup.open, false)
    rollup.querySelector<HTMLElement>(':scope > summary')?.click()
    rollup.querySelector<HTMLElement>(':scope > summary')?.click()
    assert.equal(rollup.open, false)
    await delay(0)

    updateToolCall(store, messageId, 'tc-running', {
      status: 'done',
      result: 'passed',
    })
    addToolCall(store, messageId, {
      id: 'tc-later',
      name: 'read_file',
      args: { path: 'package.json' },
      status: 'running',
      result: null,
    })
    await delay(350)
    assert.equal(rollup.open, false, 'status updates overrode the user-closed state')

    createThread(store)
    store.setState({ activeThreadId: threadId })
    store.emit('threads_changed')
    const restored = document.querySelector<HTMLDetailsElement>('.tool-card-rollup')
    assert.ok(restored)
    assert.equal(restored.open, false, 'thread switching lost the user-closed state')
  })

  it('retains an explicit user-open after settled work compacts', async () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())
    setThreadStatus(store, threadId, 'running')
    addToolCall(store, messageId, {
      id: 'tc-explicit-open',
      name: 'run_shell',
      args: { command: 'npm test' },
      status: 'running',
      result: null,
    })

    const rollup = document.querySelector<HTMLDetailsElement>('.tool-card-rollup')
    assert.ok(rollup)
    await delay(350)
    assert.equal(rollup.open, false)
    rollup.querySelector<HTMLElement>(':scope > summary')?.click()
    assert.equal(rollup.open, true)

    updateToolCall(store, messageId, 'tc-explicit-open', {
      status: 'done',
      result: 'passed',
    })
    setThreadStatus(store, threadId, 'idle')
    await delay(1_100)
    assert.equal(rollup.open, true, 'explicit user-open state was compacted')
  })

  it('reserves the activity icon slot when a running tool settles', () => {
    const store = createStore()
    const threadId = createThread(store)
    const messageId = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, messageId, {
      id: 'tc-shell',
      name: 'run_shell',
      args: {},
      status: 'running',
      result: null,
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const runningCard = qsRequired(host, '[data-tool-id="tc-shell"]')
    const runningSlot = qsRequired(runningCard, '.tool-activity-icon-slot')
    assert.equal(runningCard.querySelector('.tool-name')?.textContent, 'Running command')
    assert.ok(runningSlot.querySelector('[data-icon="reasoning-activity"]'))

    updateToolCall(store, messageId, 'tc-shell', {
      status: 'done',
      result: 'passed',
    })

    const settledCard = qsRequired(host, '[data-tool-id="tc-shell"]')
    const settledSlot = qsRequired(settledCard, '.tool-activity-icon-slot')
    assert.equal(settledCard.querySelector('.tool-name')?.textContent, 'Ran command')
    assert.equal(settledSlot.childElementCount, 0, 'settled slot stays reserved but empty')
  })
  it('keeps successful activity and reasoning closed beside the visible failure', () => {
    mountWithTools()
    const rollup = qsRequired<HTMLDetailsElement>(document, '.tool-card-rollup')
    assert.equal(rollup.open, false)
    assert.equal(
      rollup.querySelector('.tool-name')?.textContent,
      'Inspected the repo layout · 1 failed',
    )
    assert.equal(document.querySelector('.message-body > .message-reasoning'), null)
    assert.equal(qsRequired<HTMLDetailsElement>(rollup, '.message-reasoning').open, false)
    const failure = qsRequired<HTMLDetailsElement>(document, '.msg > [data-tool-id="tc-read-2"]')
    assert.equal(failure.open, true)
    assert.match(failure.textContent, /ENOENT/)
  })
  it('expands directly into successful tools, without another group to open', () => {
    mountWithTools()
    const rollup = qsRequired<HTMLDetailsElement>(document, '.tool-card-rollup')
    qsRequired(rollup, 'summary').click()
    assert.equal(rollup.querySelector('.tool-card-group'), null)
    assert.equal(rollup.querySelectorAll('.tool-rollup-body > .tool-card').length, 2)
    assert.equal(rollup.querySelector('[data-tool-id="tc-read-2"]'), null)
  })
  it('keeps a user-expanded tool open across a tool update', () => {
    const { store, messageId } = mountWithTools()
    const rollup = qsRequired<HTMLDetailsElement>(document, '.tool-card-rollup')
    const item = qsRequired<HTMLDetailsElement>(rollup, '[data-tool-id="tc-read-1"]')
    qsRequired(rollup, 'summary').click()
    qsRequired(item, 'summary').click()
    updateToolCall(store, messageId, 'tc-list-1', { result: 'updated listing' })
    assert.strictEqual(document.querySelector('.tool-card-rollup'), rollup)
    assert.equal(rollup.open, true)
    assert.equal(item.open, true)
    assert.equal(qsRequired<HTMLDetailsElement>(rollup, '[data-tool-id="tc-list-1"]').open, false)
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
    // Collapsed by default — its body (including .tool-result) is deferred
    // until it opens.
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))
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
    // Collapsed by default — its body (including .tool-result) is deferred
    // until it opens.
    card.querySelector('.tool-card-header')?.dispatchEvent(new MouseEvent('click'))
    const resultEl = card.querySelector('.tool-result')
    assert.ok(resultEl, 'expected a tool-result section')
    // The fence must become a real code element, not literal backticks.
    assert.ok(resultEl.classList.contains('tool-result-markdown'))
    assert.ok(resultEl.querySelector('code'), 'expected a rendered code element')
    assert.equal(resultEl.textContent.includes('```'), false)
    assert.ok(resultEl.textContent.includes('(Bash completed with no output)'))
  })
})
