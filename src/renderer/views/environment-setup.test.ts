import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type {
  EnvironmentSetupApplyResult,
  EnvironmentSetupStatus,
  EnvironmentSuggestion,
} from '@shared/environment-setup.ts'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  mountEnvironmentSetupOffer,
  openEnvironmentSetupReview,
  suggestionEvidence,
} from './environment-setup.ts'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const NOW = Date.UTC(2026, 9, 25, 12)

function suggestion(overrides: Partial<EnvironmentSuggestion>): EnvironmentSuggestion {
  return {
    id: 'id-1',
    kind: 'web-origin',
    value: 'https://docs.example.com',
    label: 'Allow https://docs.example.com',
    risk: 'The agent can fetch pages from this origin without asking.',
    approvals: 6,
    threads: 2,
    lastAt: NOW,
    examples: ['https://docs.example.com'],
    checked: true,
    declined: false,
    ...overrides,
  }
}

interface Calls {
  applied: Array<[string, string[]]>
  dismissed: boolean[]
}

function api(
  suggestions: EnvironmentSuggestion[],
  status: EnvironmentSetupStatus = { offer: true, promptCount: 9 },
): { client: ApiClient; calls: Calls } {
  const base = createFakeApi()
  const calls: Calls = { applied: [], dismissed: [] }
  const client: ApiClient = {
    ...base,
    environmentSetup: {
      status: () => Promise.resolve(status),
      review: () => Promise.resolve({ reviewId: 'review-1', suggestions, windowDays: 30 }),
      apply: (reviewId, ids): Promise<EnvironmentSetupApplyResult> => {
        calls.applied.push([reviewId, ids])
        return Promise.resolve({ applied: [], undoId: null })
      },
      undo: () => Promise.resolve([]),
      dismiss: (forever) => {
        calls.dismissed.push(forever)
        return Promise.resolve()
      },
    },
  }
  return { client, calls }
}

afterEach(() => {
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove()
  document.body.replaceChildren()
})

describe('environment setup review', () => {
  it('describes the evidence in plain language', () => {
    assert.equal(
      suggestionEvidence(
        suggestion({ approvals: 1, threads: 1, lastAt: NOW - 3 * 86_400_000 }),
        NOW,
      ),
      'You approved this once in 1 thread, most recently 3 days ago.',
    )
  })

  it('groups suggestions, starts with main’s ticks and sends back only ticked ids', async () => {
    const { client, calls } = api([
      suggestion({ id: 'origin', checked: true }),
      suggestion({
        id: 'xcode',
        kind: 'trusted-command',
        value: 'xcodebuild',
        label: 'Trust xcodebuild to run outside the sandbox',
        checked: false,
      }),
      suggestion({
        id: 'refused',
        kind: 'trusted-command',
        value: 'make',
        label: 'Trust make to run outside the sandbox',
        declined: true,
        checked: true,
      }),
    ])
    const closed = openEnvironmentSetupReview(client)
    await tick()
    const dialog = document.querySelector('#environment-setup-dialog')
    assert.ok(dialog)
    const sections = [...dialog.querySelectorAll('.environment-setup-section h3')].map(
      (heading) => heading.textContent,
    )
    assert.deepEqual(sections, ['Web origins', 'Trusted commands'])

    const box = (id: string): HTMLInputElement | null =>
      dialog.querySelector<HTMLInputElement>(`input[data-suggestion-id="${id}"]`)
    assert.equal(box('origin')?.checked, true)
    assert.equal(box('xcode')?.checked, false)
    assert.equal(box('refused')?.disabled, true)
    assert.equal(box('refused')?.checked, false)

    const apply = dialog.querySelector<HTMLButtonElement>('.environment-setup-apply')
    assert.ok(apply)
    assert.equal(apply.textContent, 'Apply 1 change')
    const xcode = box('xcode')
    assert.ok(xcode)
    xcode.checked = true
    xcode.dispatchEvent(new Event('change'))
    assert.equal(apply.textContent, 'Apply 2 changes')

    apply.click()
    await tick()
    await closed
    assert.deepEqual(calls.applied, [['review-1', ['origin', 'xcode']]])
  })

  it('explains an empty review instead of showing an empty form', async () => {
    const { client } = api([])
    void openEnvironmentSetupReview(client)
    await tick()
    const dialog = document.querySelector('#environment-setup-dialog')
    assert.match(dialog?.querySelector('.environment-setup-empty')?.textContent ?? '', /3 times/)
    assert.equal(
      dialog?.querySelector<HTMLButtonElement>('.environment-setup-apply')?.disabled,
      true,
    )
  })
})

describe('environment setup offer', () => {
  it('shows the count from main and dismisses for good', async () => {
    const { client, calls } = api([])
    const store = createStore({ activeProjectId: 'p', activeThreadId: 't' })
    const offer = mountEnvironmentSetupOffer(store, client)
    document.body.append(offer.element)
    await tick()
    assert.equal(offer.element.hidden, false)
    assert.match(offer.element.textContent, /asked you 9 times this week/)

    offer.element.querySelector<HTMLButtonElement>('.environment-setup-notice-never')?.click()
    assert.equal(offer.element.hidden, true)
    assert.deepEqual(calls.dismissed, [true])
    offer.destroy()
  })

  it('stays hidden when main does not offer', async () => {
    const { client } = api([], { offer: false, promptCount: 0 })
    const store = createStore({ activeProjectId: 'p', activeThreadId: 't' })
    const offer = mountEnvironmentSetupOffer(store, client)
    await tick()
    assert.equal(offer.element.hidden, true)
    offer.destroy()
  })
})
