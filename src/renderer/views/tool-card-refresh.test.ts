import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import type { ToolCall } from '@shared/types'
import type { ToolCallDisplayItem } from '@shared/tools/tool-display.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  cardStatus,
  createToolCardRefresher,
  toolCardKey,
  type ToolCardDom,
  type ToolCardRefresher,
} from './tool-card-refresh.ts'

// Component tests for the tool-card refresh extracted from mountConversation.
// The card markup builders are injected, so these tests count what the
// refresher builds, patches and keeps, and check that open state comes from the
// disclosure model rather than from whatever the previous DOM showed.

interface Calls {
  created: string[]
  reconciled: string[]
  keptReadingPosition: number
}

function itemId(item: ToolCallDisplayItem): string {
  return item.type === 'individual' ? item.toolCall.id : item.key
}

function fakeDom(calls: Calls): ToolCardDom {
  const noop = (): void => {}
  return {
    createToolCard(item): HTMLDetailsElement {
      calls.created.push(itemId(item))
      const card = document.createElement('details')
      card.className = 'tool-card'
      card.dataset['toolId'] = itemId(item)
      const summary = document.createElement('summary')
      summary.textContent = item.label
      card.append(summary)
      return card
    },
    reconcileToolCard(card, item): void {
      calls.reconciled.push(itemId(item))
      qsRequired(card, ':scope > summary').textContent = item.label
    },
    ensureToolCardBodyRendered: noop,
    syncToolResultContent: noop,
    syncToolRunMemberVisibility: noop,
    syncNestedRollupReasoning: noop,
    syncRunStepReasoning: noop,
    syncReasoningEl: noop,
  }
}

interface Harness {
  store: ReturnType<typeof createStore>
  messageId: string
  msgEl: HTMLElement
  calls: Calls
  refresher: ToolCardRefresher
  render(): void
}

const refreshers: ToolCardRefresher[] = []

function harness(): Harness {
  const store = createStore()
  createThread(store)
  const messageId = addMessage(store, store.getState().activeThreadId ?? '', 'assistant', '')
  const list = document.createElement('div')
  const msgEl = document.createElement('div')
  msgEl.className = 'msg msg-assistant'
  msgEl.dataset['messageId'] = messageId
  const body = document.createElement('div')
  body.className = 'message-body'
  msgEl.append(body)
  list.append(msgEl)
  document.body.append(list)
  const calls: Calls = { created: [], reconciled: [], keptReadingPosition: 0 }
  const refresher = createToolCardRefresher({
    store,
    api: createFakeApi(),
    list,
    dom: fakeDom(calls),
    isPinnedToBottom: () => true,
    scrollToBottom: () => {},
    keepReadingPosition(update) {
      calls.keptReadingPosition++
      update()
    },
    conciseEnabledFor: () => false,
  })
  refreshers.push(refresher)
  const render = (): void => {
    const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
    const msg = thread?.messages.find((m) => m.id === messageId)
    refresher.renderToolCards(msgEl, msg?.toolCalls ?? [])
  }
  return { store, messageId, msgEl, calls, refresher, render }
}

function call(id: string, name: string, status: ToolCall['status'] = 'running'): ToolCall {
  const args = name === 'run_shell' ? { command: `echo ${id}` } : { path: `${id}.md` }
  return { id, name, args, status, result: status === 'running' ? null : 'ok' }
}

function card(msgEl: HTMLElement, id: string): HTMLDetailsElement {
  return qsRequired<HTMLDetailsElement>(msgEl, `:scope > .tool-card[data-tool-id="${id}"]`)
}

afterEach(() => {
  for (const refresher of refreshers.splice(0)) refresher.disclosures.dispose()
  document.body.replaceChildren()
})

describe('tool-card refresh (component)', () => {
  it('reuses an unchanged card verbatim instead of rebuilding or patching it', () => {
    const h = harness()
    addToolCall(h.store, h.messageId, call('tc-1', 'run_shell', 'done'))
    h.render()
    const first = card(h.msgEl, 'tc-1')
    h.render()
    h.render()
    assert.strictEqual(card(h.msgEl, 'tc-1'), first)
    assert.deepEqual(h.calls.created, ['tc-1'])
    assert.deepEqual(h.calls.reconciled, [])
  })

  it('patches a changed card in place, keeping its node', () => {
    const h = harness()
    addToolCall(h.store, h.messageId, call('tc-1', 'run_shell'))
    h.render()
    const first = card(h.msgEl, 'tc-1')
    updateToolCall(h.store, h.messageId, 'tc-1', { status: 'done', result: 'ok' })
    h.render()
    assert.strictEqual(card(h.msgEl, 'tc-1'), first)
    assert.equal(first.dataset['status'], 'done')
    assert.deepEqual(h.calls.created, ['tc-1'])
    assert.deepEqual(h.calls.reconciled, ['tc-1'])
  })

  it('places cards after the message body in tool order and drops cards whose calls are gone', () => {
    const h = harness()
    addToolCall(h.store, h.messageId, call('tc-1', 'run_shell', 'done'))
    addToolCall(h.store, h.messageId, call('tc-2', 'run_shell', 'done'))
    h.render()
    const order = (): string[] =>
      Array.from(h.msgEl.children).map((node) =>
        node instanceof HTMLElement ? (node.dataset['toolId'] ?? node.className) : '',
      )
    // Two shell calls merge into one group card; the body stays first.
    assert.equal(order()[0], 'message-body')
    assert.equal(h.msgEl.querySelectorAll(':scope > .tool-card').length, 1)

    const thread = h.store.getState().threads[0]
    const message = thread?.messages.find((m) => m.id === h.messageId)
    assert.ok(message)
    h.refresher.renderToolCards(h.msgEl, message.toolCalls.slice(0, 1))
    assert.deepEqual(order(), ['message-body', 'tc-1'], 'the group card should be replaced')
    h.refresher.renderToolCards(h.msgEl, [])
    assert.deepEqual(order(), ['message-body'])
  })

  it('keeps a user-closed card closed through running → done → running, whatever the DOM says', () => {
    const h = harness()
    addToolCall(h.store, h.messageId, call('tc-1', 'run_shell', 'error'))
    h.render()
    const tc = card(h.msgEl, 'tc-1')
    assert.equal(tc.open, true, 'a failure opens without a click')
    qsRequired(tc, ':scope > summary').click()
    assert.equal(tc.open, false)

    for (const status of ['running', 'done', 'running'] as const) {
      updateToolCall(h.store, h.messageId, 'tc-1', { status, result: null })
      // A stale or tampered DOM must not leak back into the choice.
      tc.open = true
      h.render()
      assert.equal(card(h.msgEl, 'tc-1').open, false, `reopened on ${status}`)
    }
  })

  it('keeps a user-opened card open after it completes, even if the DOM was closed', () => {
    const h = harness()
    addToolCall(h.store, h.messageId, call('tc-1', 'run_shell'))
    h.render()
    const tc = card(h.msgEl, 'tc-1')
    assert.equal(tc.open, false, 'running detail reveals only after the delay')
    qsRequired(tc, ':scope > summary').click()
    updateToolCall(h.store, h.messageId, 'tc-1', { status: 'done', result: 'ok' })
    tc.open = false
    h.render()
    assert.equal(card(h.msgEl, 'tc-1').open, true)
  })

  it('restores a reasoning trail choice onto a freshly built trail element', () => {
    const h = harness()
    const trail = (): HTMLDetailsElement => {
      const details = document.createElement('details')
      details.className = 'message-reasoning'
      details.append(document.createElement('summary'))
      qsRequired(h.msgEl, '.message-body').replaceChildren(details)
      return details
    }
    const first = trail()
    h.refresher.registerReasoningDisclosures(h.msgEl)
    qsRequired(first, ':scope > summary').click()
    assert.equal(first.open, true)

    const rebuilt = trail()
    assert.equal(rebuilt.open, false)
    h.refresher.registerReasoningDisclosures(h.msgEl)
    assert.equal(rebuilt.open, true, 'the user-open choice was lost')
  })

  it('refreshes a message inside the host reading-position guard, and skips unknown ids', () => {
    const h = harness()
    addToolCall(h.store, h.messageId, call('tc-1', 'run_shell', 'done'))
    h.refresher.refreshToolCards('missing')
    assert.equal(h.calls.keptReadingPosition, 0)
    h.refresher.refreshToolCards(h.messageId)
    assert.equal(h.calls.keptReadingPosition, 1)
    assert.deepEqual(h.calls.created, ['tc-1'])
  })
})

describe('tool-card refresh helpers', () => {
  it('derives one card status from its calls', () => {
    assert.equal(cardStatus([call('a', 'run_shell', 'done'), call('b', 'run_shell')]), 'running')
    assert.equal(
      cardStatus([call('a', 'run_shell', 'done'), call('b', 'run_shell', 'error')]),
      'error',
    )
    assert.equal(cardStatus([call('a', 'run_shell', 'done')]), 'done')
  })

  it('marks a command that never started, but not a rollup where other calls ran', () => {
    const declined: ToolCall = {
      ...call('a', 'run_shell', 'done'),
      commandPhase: { state: 'not_started', since: 1, launched: false, reason: 'Declined.' },
    }
    assert.equal(cardStatus([declined]), 'interrupted')
    assert.equal(cardStatus([declined, call('b', 'read_file', 'done')]), 'done')
  })

  it('keys a card by its stable identity', () => {
    const individual: ToolCallDisplayItem = {
      type: 'individual',
      toolCall: call('tc-9', 'run_shell'),
      label: 'Ran',
    }
    assert.equal(toolCardKey(individual), 't:tc-9')
  })
})
