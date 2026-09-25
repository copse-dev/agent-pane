import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  appendReasoning,
  createThread,
  setMessageContent,
  setMessageRunSummary,
  setThreadStatus,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// Cross-message tool runs in the conversation VIEW. The derivation and the
// display-item shapes are covered in src/shared/tools/{tool-runs,tool-display}
// .test.ts; this file asserts what a thread with the recorded topology actually
// renders — one run summary rather than a rollup per persisted message.

function fakeApi(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: { ...base['agent'], run: () => Promise.resolve(), abort: () => Promise.resolve() },
  } satisfies ApiClient
}

function mount(store: ReturnType<typeof createStore>): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, fakeApi())
  return host
}

/** Add `n` settled reads to `messageId`, ids prefixed with the message id. */
function addReads(
  store: ReturnType<typeof createStore>,
  messageId: string,
  n: number,
  status: 'done' | 'error' = 'done',
): void {
  for (let i = 0; i < n; i++) {
    addToolCall(store, messageId, {
      id: `${messageId}-${String(i)}`,
      name: 'read_file',
      args: { path: `src/file-${String(i)}.ts` },
      status,
      result: status === 'error' ? 'Error: ENOENT' : '// contents',
    })
  }
}

/**
 * The recorded trace: a prompt, a commentary message that also ran tools, and
 * four tool-only assistant segments after it.
 */
function seedRun(): { store: ReturnType<typeof createStore>; threadId: string; ids: string[] } {
  const store = createStore()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Run a read-only health check')
  const a1 = addMessage(store, threadId, 'assistant', 'On it.')
  const rest = [
    addMessage(store, threadId, 'assistant', ''),
    addMessage(store, threadId, 'assistant', ''),
    addMessage(store, threadId, 'assistant', ''),
    addMessage(store, threadId, 'assistant', ''),
  ]
  addReads(store, a1, 6)
  addReads(store, rest[0] ?? '', 6)
  addReads(store, rest[1] ?? '', 2)
  addReads(store, rest[2] ?? '', 2)
  addReads(store, rest[3] ?? '', 2)
  return { store, threadId, ids: [a1, ...rest] }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('cross-message tool runs (component)', () => {
  it('keeps late reasoning in message order and finalizes every body on stop', () => {
    const { store, threadId, ids } = seedRun()
    const host = mount(store)
    setThreadStatus(store, threadId, 'running')
    appendReasoning(store, ids.at(-1) ?? '', '**unfinished')
    appendReasoning(store, ids[0] ?? '', 'Earlier thought.')
    const texts = [...host.querySelectorAll('.message-reasoning-text')]
    assert.deepEqual(
      texts.map((text) => text.getAttribute('data-reasoning-message-id')),
      [ids[0], ids.at(-1)],
    )
    setThreadStatus(store, threadId, 'idle')
    assert.equal(host.querySelector('.message-reasoning-live'), null)
    assert.equal(texts[1]?.textContent, '**unfinished')
  })

  it('removes departed reasoning when a run shortens to one message', () => {
    const store = createStore()
    const threadId = createThread(store)
    const first = addMessage(store, threadId, 'assistant', '')
    addReads(store, first, 2)
    appendReasoning(store, first, 'First thought.')
    const second = addMessage(store, threadId, 'assistant', '')
    addReads(store, second, 1)
    appendReasoning(store, second, 'Second thought.')
    const host = mount(store)
    setMessageContent(store, second, 'A new update.')
    const firstBubble = qsRequired(host, `[data-message-id="${first}"]`)
    assert.equal(firstBubble.querySelectorAll('.message-reasoning-text').length, 1)
    assert.equal(
      firstBubble.querySelector('.message-reasoning-text')?.textContent,
      'First thought.',
    )
  })

  it('keeps a live activity indicator when reasoning is inside a closed rollup', () => {
    const { store, threadId, ids } = seedRun()
    const host = mount(store)
    setThreadStatus(store, threadId, 'running')
    appendReasoning(store, ids.at(-1) ?? '', 'Still checking.')
    store.emit('agent_activity', threadId, 'Reasoning…')
    assert.equal(qsRequired(host, '.agent-activity').hidden, false)
    assert.equal(qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup').open, false)
  })

  it('keeps the first live disclosure and tool at the same depth as messages arrive', () => {
    const store = createStore()
    const threadId = createThread(store)
    const host = mount(store)
    setThreadStatus(store, threadId, 'running')
    const first = addMessage(store, threadId, 'assistant', '')
    appendReasoning(store, first, 'Initial reasoning.')
    addReads(store, first, 1)
    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    qsRequired(run, 'summary').click()
    const tool = qsRequired(run, '[data-tool-id]')
    const reasoning = qsRequired<HTMLDetailsElement>(run, '.message-reasoning')
    qsRequired(reasoning, 'summary').click()
    const next = addMessage(store, threadId, 'assistant', '')
    appendReasoning(store, next, 'Next thought.')
    addReads(store, next, 1)
    assert.ok(host.querySelector('.tool-card-rollup') === run, 'rollup identity survives')
    assert.ok(run.querySelector('[data-tool-id]') === tool, 'tool identity survives')
    assert.ok(run.querySelector('.message-reasoning') === reasoning, 'reasoning identity survives')
    assert.equal(run.open, true)
    assert.equal(reasoning.open, true)
    assert.equal(host.querySelectorAll('.message-reasoning').length, 1)
    assert.equal(run.querySelector('.tool-card-step, .tool-card-rollup'), null)
  })

  it('shows a failure without opening successful work or reasoning', () => {
    const { store, threadId } = seedRun()
    const host = mount(store)
    const last = addMessage(store, threadId, 'assistant', '')
    appendReasoning(store, last, 'Checking the failing command.')
    addReads(store, last, 1, 'error')
    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    const failure = qsRequired<HTMLDetailsElement>(host, `.msg > [data-tool-id="${last}-0"]`)
    assert.equal(run.open, false)
    assert.equal(failure.open, true)
    assert.match(failure.textContent, /ENOENT/)
    assert.equal(qsRequired<HTMLDetailsElement>(run, '.message-reasoning').open, false)
    qsRequired(failure, 'summary').click()
    updateToolCall(store, last, `${last}-0`, { result: 'Error: still missing' })
    assert.equal(failure.open, false, 'explicit failure collapse survives updates')
  })

  it('collapses a burst spanning five messages into one run summary', () => {
    const { store, ids } = seedRun()
    const host = mount(store)

    const rollups = host.querySelectorAll('.tool-card-rollup')
    assert.equal(rollups.length, 1, 'one summary for the whole run, not one per message')
    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    assert.equal(run.dataset['rollupKey'], 'run')
    // The run renders on its anchor — the message that started the burst.
    assert.equal(run.closest('.msg')?.getAttribute('data-message-id'), ids[0])
    assert.equal(
      run.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
      'Used 18 tools',
    )

    assert.equal(run.querySelector('.tool-card-step'), null)
    assert.equal(run.querySelectorAll('.tool-rollup-body > .tool-card').length, 18)
    // Members retain their identity for event routing without empty transcript rows.
    for (const id of ids.slice(1)) {
      const memberEl = qsRequired(host, `[data-message-id="${id}"]`)
      assert.equal(
        memberEl.querySelector('.tool-card'),
        null,
        `${id} must not render its own cards`,
      )
      assert.equal(memberEl.classList.contains('msg-tool-run-member'), true)
      assert.equal(memberEl.hidden, true, `${id} must not leave an empty transcript row`)
    }
  })

  it('expands straight into every tool, without per-message or category wrappers', () => {
    const { store } = seedRun()
    const host = mount(store)
    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    assert.equal(run.open, false)
    qsRequired(run, 'summary').click()
    assert.equal(run.open, true)
    assert.equal(run.querySelectorAll('.tool-rollup-body > .tool-card').length, 18)
    assert.equal(run.querySelector('.tool-card-step, .tool-card-group, .tool-card-rollup'), null)
  })
  it('preserves expanded tools when another member updates', () => {
    const { store, ids } = seedRun()
    const host = mount(store)
    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    qsRequired(run, 'summary').click()
    const first = qsRequired<HTMLDetailsElement>(run, `[data-tool-id="${String(ids[0])}-0"]`)
    qsRequired(first, 'summary').click()
    updateToolCall(store, ids.at(-1) ?? '', `${String(ids.at(-1))}-0`, { result: 'changed' })
    assert.ok(host.querySelector('.tool-card-rollup') === run, 'rollup identity survives')
    assert.equal(run.open, true)
    assert.equal(first.open, true)
    assert.equal(
      qsRequired<HTMLDetailsElement>(run, `[data-tool-id="${String(ids[1])}-0"]`).open,
      false,
    )
  })
  it('shows the run polish with counts and failures, and updates it in place', () => {
    const { store, threadId, ids } = seedRun()
    const failing = addMessage(store, threadId, 'assistant', '')
    addReads(store, failing, 1, 'error')
    const host = mount(store)

    assert.equal(
      qsRequired(host, '.tool-card-rollup > .tool-card-header .tool-name').textContent,
      'Used 19 tools · 1 failed',
    )

    setMessageRunSummary(store, ids[0] ?? '', 'Checked CI, branch state, and test coverage')

    assert.equal(
      qsRequired(host, '.tool-card-rollup > .tool-card-header .tool-name').textContent,
      'Checked CI, branch state, and test coverage · 19 tools · 1 failed',
    )
  })

  it('collects member reasoning into one closed disclosure', () => {
    const { store, ids } = seedRun()
    const host = mount(store)
    appendReasoning(store, ids[1] ?? '', 'Checking the build.')
    appendReasoning(store, ids[2] ?? '', 'Checking whether the oracle ran.')
    assert.equal(host.querySelector('.message-body > .message-reasoning'), null)
    assert.equal(host.querySelectorAll('.message-reasoning').length, 1)
    const trail = qsRequired<HTMLDetailsElement>(host, '.tool-rollup-body > .message-reasoning')
    assert.equal(trail.open, false)
    assert.match(trail.textContent, /Checking the build/)
    assert.match(trail.textContent, /Checking whether the oracle ran/)
  })
  it('retains settled reasoning paragraphs when later run steps receive chunks', () => {
    const { store, ids } = seedRun()
    const settledId = ids[1] ?? ''
    const liveId = ids.at(-1) ?? ''
    appendReasoning(store, settledId, 'Completed **investigation**.\n\nEverything checked.')
    const host = mount(store)
    const settled = qsRequired(host, `[data-reasoning-message-id="${settledId}"] p`)
    for (let index = 0; index < 8; index++) {
      appendReasoning(store, liveId, `More reasoning ${String(index)}. `)
      assert.ok(settled.isConnected, 'later chunks must not replace completed-step markdown')
    }
  })

  it('hands a member its tools back when it gains prose', () => {
    const { store, ids } = seedRun()
    const host = mount(store)
    const member = ids[1] ?? ''

    // The continuation heuristic can resume text on a bubble that so far
    // carried only tools. Prose is a run boundary, so the member leaves.
    setMessageContent(store, member, 'Actually, the oracle found nothing.')

    const restoredMember = qsRequired(host, `[data-message-id="${member}"]`)
    assert.equal(restoredMember.classList.contains('msg-tool-run-member'), false)
    assert.equal(restoredMember.hidden, false, 'visible prose restores the member bubble')

    const runs = [...host.querySelectorAll<HTMLElement>('.tool-card-rollup')]
    assert.deepEqual(
      runs.map((run) => run.closest('.msg')?.getAttribute('data-message-id')),
      [ids[0], member],
      'the member anchors its own run once it has prose',
    )
    const [shortened, departed] = runs
    assert.ok(shortened)
    assert.ok(departed)
    // The shortened first run no longer claims the departed message's tools.
    assert.equal(
      shortened.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
      'Read files',
    )
    assert.equal(shortened.querySelector('.tool-card-step'), null)
    assert.equal(
      departed.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
      'Used 12 tools',
    )
  })

  it('releases a reasoning-only member when it gains prose', () => {
    const { store, threadId } = seedRun()
    const host = mount(store)

    // A bubble that has streamed only reasoning is still absorbed as a step —
    // its trail hangs on the anchor's rollup, not on its own body.
    const member = addMessage(store, threadId, 'assistant', '')
    appendReasoning(store, member, 'Double-checking the oracle output.')
    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    assert.equal(
      run.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
      'Used 18 tools',
    )
    assert.ok(run.querySelector(`[data-reasoning-message-id="${member}"]`))
    const memberEl = qsRequired(host, `[data-message-id="${member}"]`)
    assert.equal(memberEl.querySelector('.message-reasoning'), null)

    // Prose is a run boundary even for a member that never ran a tool: the
    // anchor drops the step and the bubble takes its reasoning trail back.
    setMessageContent(store, member, 'The oracle output is clean.')
    store.emit('message_done', member)

    const runAfter = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    assert.equal(
      runAfter.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
      'Used 18 tools',
    )
    assert.equal(
      host.querySelector(`[data-reasoning-message-id="${member}"]`),
      null,
      'no stale step for the departed member',
    )
    assert.equal(runAfter.querySelectorAll('.tool-rollup-body > .tool-card').length, 18)
    const trail = qsRequired(memberEl, '.message-body > .message-reasoning')
    assert.equal(
      trail.querySelector('.message-reasoning-text')?.textContent.trim(),
      'Double-checking the oracle output.',
    )
    assert.equal(trail.querySelector('.message-reasoning-title')?.textContent, 'Reasoned')
  })

  it('leaves an ordinary single-message turn on the per-message rollup', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'hello')
    const only = addMessage(store, threadId, 'assistant', 'Done.')
    addReads(store, only, 3)
    const host = mount(store)

    const rollup = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    assert.equal(rollup.dataset['rollupKey'], 'turn')
    assert.equal(rollup.querySelector('.tool-card-step'), null, 'no step nesting for one message')
    assert.equal(
      rollup.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
      'Read files',
    )
  })

  it('starts a new run at the next visible assistant response', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'hello')
    const a1 = addMessage(store, threadId, 'assistant', 'First pass.')
    const a2 = addMessage(store, threadId, 'assistant', '')
    const a3 = addMessage(store, threadId, 'assistant', 'Second pass.')
    const a4 = addMessage(store, threadId, 'assistant', '')
    for (const id of [a1, a2, a3, a4]) addReads(store, id, 2)
    const host = mount(store)

    const runs = [...host.querySelectorAll<HTMLElement>('.tool-card-rollup')]
    assert.equal(runs.length, 2, 'the commentary message ends the first run')
    assert.deepEqual(
      runs.map((run) => run.closest('.msg')?.getAttribute('data-message-id')),
      [a1, a3],
    )
    for (const run of runs) {
      assert.equal(
        run.querySelector(':scope > .tool-card-header .tool-name')?.textContent,
        'Used 4 tools',
      )
    }
  })
})
