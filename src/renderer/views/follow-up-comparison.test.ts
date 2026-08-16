import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, getThreadById } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import { DETERMINISTIC_FOLLOW_UP_IDS } from '@shared/follow-ups/presets.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'
import { openComparisonModelDialog } from './comparison-model-dialog.ts'
import { takeQuietRun } from '../controller/quiet-runs.ts'
import { safeJsonParse } from '@shared/safe-json.ts'

/** The models a retry-comparison payload carries, read without casting. */
function pickedModels(payloadJson: string): unknown {
  const parsed = safeJsonParse(payloadJson)
  if (typeof parsed !== 'object' || parsed === null) return null
  if (!('comparisonModels' in parsed)) return null
  return parsed.comparisonModels
}

// The "Compare models" bubble, end to end through the renderer: the pack's
// suggestion arrives as a `model-compare` action, the click opens a picker
// instead of stuffing the composer, and confirming runs the comparison with the
// models the user chose — no approval prompt, and no completion chime.

const COMPARE: FollowUpSuggestion = {
  id: 'compare-models',
  label: 'Compare models',
  action: 'model-compare',
}
const PROMPT_BUBBLE: FollowUpSuggestion = {
  id: 'run-tests',
  label: 'Run the tests',
  action: 'prompt',
  prompt: 'Run the relevant tests.',
}

interface Harness {
  api: ApiClient
  comparisonRuns: { threadId: string; payload: string }[]
}

function fakeApi(suggestions: FollowUpSuggestion[]): Harness {
  const base = createFakeApi()
  const comparisonRuns: { threadId: string; payload: string }[] = []
  const api: ApiClient = {
    ...base,
    agent: {
      ...base['agent'],
      suggestFollowUps: () => Promise.resolve(suggestions),
      comparisonModels: () => Promise.resolve({ a: 'model-a', b: 'model-b', judge: 'model-j' }),
      retryComparison: (_projectId: string, threadId: string, payload: string) => {
        comparisonRuns.push({ threadId, payload })
        return Promise.resolve()
      },
    },
  }
  return { api, comparisonRuns }
}

function storeWithFinishedTurn(): { store: ReturnType<typeof createStore>; threadId: string } {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'do the thing')
  addMessage(store, threadId, 'assistant', 'done')
  return { store, threadId }
}

/** Let the mount's async fetch + the dialog's async model load settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Choose the three models in an open picker, as clicking through it would. */
function selectModels(dialog: HTMLElement, models: { a: string; b: string; judge: string }): void {
  const selects = [...dialog.querySelectorAll('select')]
  assert.equal(selects.length, 3)
  for (const [i, value] of [models.a, models.b, models.judge].entries()) {
    const select = selects[i]
    assert.ok(select)
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    select.append(option)
    select.value = value
  }
}

describe('the "Compare models" follow-up bubble', () => {
  it('opens the model picker rather than sending a prompt', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, comparisonRuns } = fakeApi([COMPARE])
    const sentPrompts: string[] = []
    const mount = mountFollowUpSuggestions(store, api, (prompt) => {
      sentPrompts.push(prompt)
    })
    document.body.append(mount.root)

    store.emit('thread_status_changed', threadId, 'idle')
    await flush()

    const bubble = mount.root.querySelector('.follow-up-bubble[data-id="compare-models"]')
    assert.ok(bubble instanceof HTMLElement, 'the pack bubble should render')
    bubble.click()
    await flush()

    // Nothing went to the composer, and nothing has run yet — the picker is
    // open, waiting on the models. (Lengths, not deepEqual against `[]`: node's
    // strict deepEqual is an assertion signature and would narrow these arrays
    // to `never[]` for the rest of the test.)
    assert.equal(sentPrompts.length, 0)
    assert.equal(comparisonRuns.length, 0)
    const dialog = qsRequired<HTMLDialogElement>(document, '#comparison-model-dialog')
    assert.equal(dialog.open, true)

    // The picker opens on the defaults main resolved; the option list itself is
    // the shared model catalogue, which this harness does not stand up, so seed
    // the three selects the way a user's choice would.
    selectModels(dialog, { a: 'model-a', b: 'model-b', judge: 'model-j' })

    // Confirming runs the comparison with what the picker holds, and marks the
    // run quiet so its completion does not chime at someone who just clicked it.
    qsRequired(dialog, '.comparison-model-dialog-run').click()
    await flush()

    assert.equal(comparisonRuns.length, 1)
    const run = comparisonRuns[0]
    assert.ok(run)
    assert.equal(run.threadId, threadId)
    assert.deepEqual(pickedModels(run.payload), {
      a: 'model-a',
      b: 'model-b',
      judge: 'model-j',
    })
    assert.equal(takeQuietRun(threadId), true)
    assert.equal(getThreadById(store, threadId)?.comparison?.status, 'running')

    mount.destroy()
  })

  it('still routes a prompt bubble through the composer', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api } = fakeApi([PROMPT_BUBBLE])
    const sentPrompts: string[] = []
    const mount = mountFollowUpSuggestions(store, api, (prompt) => {
      sentPrompts.push(prompt)
    })
    document.body.append(mount.root)

    store.emit('thread_status_changed', threadId, 'idle')
    await flush()

    const bubble = mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]')
    assert.ok(bubble instanceof HTMLElement)
    bubble.click()
    await flush()

    assert.deepEqual(sentPrompts, ['Run the relevant tests.'])
    mount.destroy()
  })
})

describe('comparison model dialog', () => {
  it('resolves with the chosen models on Run and null on Cancel', async () => {
    const api = createFakeApi()

    const cancelled = openComparisonModelDialog(api, { a: 'a', b: 'b', judge: 'j' })
    await flush()
    const dialog = qsRequired<HTMLDialogElement>(document, '#comparison-model-dialog')
    const buttons = [
      ...dialog.querySelectorAll<HTMLButtonElement>('.comparison-model-dialog-actions button'),
    ]
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ['Cancel', 'Run comparison'],
    )
    buttons[0]?.click()
    assert.equal(await cancelled, null)

    const confirmed = openComparisonModelDialog(api, { a: 'a', b: 'b', judge: 'j' })
    await flush()
    selectModels(dialog, { a: 'picked-a', b: 'picked-b', judge: 'picked-j' })
    qsRequired(dialog, '.comparison-model-dialog-run').click()
    assert.deepEqual(await confirmed, { a: 'picked-a', b: 'picked-b', judge: 'picked-j' })
  })

  it('ignores Run while the pickers are still loading', async () => {
    const api = createFakeApi()
    const pending = openComparisonModelDialog(api, { a: 'a', b: 'b', judge: 'j' })
    const dialog = qsRequired<HTMLDialogElement>(document, '#comparison-model-dialog')

    // The pickers open on a blank "(loading…)" option; a click that lands first
    // must not start a run against empty model ids.
    qsRequired(dialog, '.comparison-model-dialog-run').click()
    await flush()
    assert.equal(dialog.open, true)

    qsRequired(dialog, '.comparison-model-dialog-cancel').click()
    assert.equal(await pending, null)
  })
})

describe('follow-up Changes chip', () => {
  it('refreshes +/- counts from recursive working-tree events (#1753)', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const listener: { current: ((root: string) => void) | null } = { current: null }
    let statsReads = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base['agent'],
        suggestFollowUps: () => Promise.resolve([PROMPT_BUBBLE]),
      },
      git: {
        ...base['git'],
        changeStats: async () => {
          statsReads++
          return { additions: statsReads, deletions: 0 }
        },
        onWorkingTreeChanged: (handler: (root: string) => void): (() => void) => {
          listener.current = handler
          return () => {
            if (listener.current === handler) listener.current = null
          }
        },
      },
    }

    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    store.emit('thread_status_changed', threadId, 'idle')
    await flush()

    assert.equal(statsReads, 1)
    assert.equal(
      mount.root.querySelector(`[data-id="${DETERMINISTIC_FOLLOW_UP_IDS.changes}"]`)?.textContent,
      'Changes+1-0',
    )
    assert.ok(listener.current)

    listener.current('/repo')
    await new Promise<void>((resolve) => setTimeout(resolve, 450))
    await flush()
    assert.equal(statsReads, 2)
    assert.equal(
      mount.root.querySelector(`[data-id="${DETERMINISTIC_FOLLOW_UP_IDS.changes}"]`)?.textContent,
      'Changes+2-0',
    )

    mount.destroy()
    assert.equal(listener.current, null)
  })
})
