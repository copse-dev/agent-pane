import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  appendReasoning,
  createThread,
  setMessageRunSummary,
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
      'Used 18 tools · 5 steps',
    )

    // Every member message keeps its bubble but contributes a step, in order.
    const steps = run.querySelectorAll<HTMLElement>('.tool-card-step')
    assert.deepEqual(
      [...steps].map((step) => step.dataset['stepMessageId']),
      ids,
    )
    for (const id of ids.slice(1)) {
      const memberEl = qsRequired(host, `[data-message-id="${id}"]`)
      assert.equal(memberEl.querySelector('.tool-card'), null, `${id} must not render its own cards`)
    }
  })

  it('expands into every step, and each step into its own operations', () => {
    const { store, ids } = seedRun()
    const host = mount(store)

    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    assert.equal(run.hasAttribute('open'), false, 'a settled run stays collapsed')
    run.open = true

    const lastStep = qsRequired<HTMLDetailsElement>(
      run,
      `.tool-card-step[data-step-message-id="${String(ids.at(-1))}"]`,
    )
    assert.equal(lastStep.querySelector('.tool-name')?.textContent, 'Read files')
    lastStep.open = true
    const group = qsRequired(lastStep, '.tool-card-group')
    assert.equal(group.querySelector('.tool-count')?.textContent, '×2')
  })

  it('keeps a user-expanded step open when a later member ticks', () => {
    const { store, ids } = seedRun()
    const host = mount(store)

    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    run.open = true
    const first = qsRequired<HTMLDetailsElement>(
      run,
      `.tool-card-step[data-step-message-id="${String(ids[0])}"]`,
    )
    first.open = true

    // A tool settling on the *last* member repaints the anchor's whole run.
    updateToolCall(store, ids.at(-1) ?? '', `${String(ids.at(-1))}-0`, { result: 'changed' })

    assert.equal(host.querySelectorAll('.tool-card-rollup').length, 1, 'no duplicate run card')
    const runAfter = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    assert.equal(runAfter.hasAttribute('open'), true, 'run stays open')
    const firstAfter = qsRequired<HTMLDetailsElement>(
      runAfter,
      `.tool-card-step[data-step-message-id="${String(ids[0])}"]`,
    )
    assert.equal(firstAfter.hasAttribute('open'), true, 'the expanded step survives the repaint')
    const untouched = qsRequired<HTMLDetailsElement>(
      runAfter,
      `.tool-card-step[data-step-message-id="${String(ids[1])}"]`,
    )
    assert.equal(untouched.hasAttribute('open'), false)
  })

  it('shows the run polish with counts and failures, and updates it in place', () => {
    const { store, threadId, ids } = seedRun()
    const failing = addMessage(store, threadId, 'assistant', '')
    addReads(store, failing, 1, 'error')
    const host = mount(store)

    assert.equal(
      qsRequired(host, '.tool-card-rollup > .tool-card-header .tool-name').textContent,
      'Used 19 tools · 6 steps · 1 failed',
    )

    setMessageRunSummary(store, ids[0] ?? '', 'Checked CI, branch state, and test coverage')

    assert.equal(
      qsRequired(host, '.tool-card-rollup > .tool-card-header .tool-name').textContent,
      'Checked CI, branch state, and test coverage · 19 tools · 6 steps · 1 failed',
    )
  })

  it('hangs each member’s reasoning on its own step, not on its bubble', () => {
    const { store, ids } = seedRun()
    const host = mount(store)

    const member = ids[2] ?? ''
    appendReasoning(store, member, 'Checking whether the oracle ran.')

    assert.equal(
      host.querySelector('.message-body > .message-reasoning'),
      null,
      'no member keeps a body-level trail',
    )
    const run = qsRequired<HTMLDetailsElement>(host, '.tool-card-rollup')
    const step = qsRequired(run, `.tool-card-step[data-step-message-id="${member}"]`)
    const trail = qsRequired(step, ':scope > .tool-rollup-body > .message-reasoning')
    assert.equal(
      trail.querySelector('.message-reasoning-text')?.textContent?.trim(),
      'Checking whether the oracle ran.',
    )
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
        'Used 4 tools · 2 steps',
      )
    }
  })
})
