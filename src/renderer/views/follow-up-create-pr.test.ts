import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, getThreadById } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import type { Message } from '@shared/types/thread.ts'
import type { PrCreateRequest, PrCreateResult } from '@shared/types/git.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'

// The "Create PR" bubble, end to end through the renderer. The turn it replaces
// was one agent call; this is the same work in two pieces — a description
// proposed while the dialog is open, then a create that runs no model at all —
// so these cover the seam: what the dialog is given, what the create is asked
// for, and that the transcript still shows it happened.

const CREATE_PR: FollowUpSuggestion = {
  id: 'create-pr',
  label: 'Create PR',
  action: 'create-pr',
  prompt: 'fallback prompt',
}

const OPENED: PrCreateResult = {
  ok: true,
  backend: 'cli',
  url: 'https://github.com/copse-dev/agent-pane/pull/7',
  number: 7,
  message: 'Opened PR #7: https://github.com/copse-dev/agent-pane/pull/7',
}

interface Harness {
  api: ApiClient
  creates: { projectId: string; threadId: string; request: PrCreateRequest }[]
  bodyRequests: string[]
}

function fakeApi(
  opts: { body?: string | null; result?: PrCreateResult; createThrows?: boolean } = {},
): Harness {
  const base = createFakeApi()
  const creates: Harness['creates'] = []
  const bodyRequests: string[] = []
  const api: ApiClient = {
    ...base,
    agent: {
      ...base['agent'],
      suggestFollowUps: () => Promise.resolve([CREATE_PR]),
      suggestPrBody: (_projectId: string, _threadId: string, contextJson: string) => {
        bodyRequests.push(contextJson)
        return Promise.resolve(opts.body ?? null)
      },
    },
    gh: {
      ...base['gh'],
      createPrForThread: (projectId: string, threadId: string, request: PrCreateRequest) => {
        creates.push({ projectId, threadId, request })
        if (opts.createThrows) return Promise.reject(new Error('gh exploded'))
        return Promise.resolve(opts.result ?? OPENED)
      },
    },
  }
  return { api, creates, bodyRequests }
}

function storeWithFinishedTurn(): { store: ReturnType<typeof createStore>; threadId: string } {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'make a pr')
  addMessage(store, threadId, 'assistant', 'done')
  store.setState({
    threads: store
      .getState()
      .threads.map((t) =>
        t.id === threadId ? { ...t, title: 'Roll up tool activity', gitBranch: 'feature/x' } : t,
      ),
  })
  return { store, threadId }
}

/** Let the mount's async fetch, the dialog's promise and the create settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

async function openBubble(
  store: ReturnType<typeof createStore>,
  threadId: string,
  api: ApiClient,
): Promise<HTMLDialogElement> {
  const mount = mountFollowUpSuggestions(store, api, () => {})
  document.body.append(mount.root)
  store.emit('thread_status_changed', threadId, 'idle')
  await flush()

  const bubble = mount.root.querySelector('.follow-up-bubble[data-id="create-pr"]')
  assert.ok(bubble instanceof HTMLElement, 'the create-pr bubble should render')
  bubble.click()
  await flush()
  return qsRequired<HTMLDialogElement>(document, '#create-pr-dialog')
}

/** The transcript's newest assistant message, which is where the card lands. */
function lastMessage(store: ReturnType<typeof createStore>, threadId: string): Message {
  const messages = getThreadById(store, threadId)?.messages ?? []
  const message = messages[messages.length - 1]
  assert.ok(message, 'the thread should have a message')
  return message
}

describe('the "Create PR" follow-up bubble', () => {
  it('opens the dialog rather than creating anything', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, creates } = fakeApi()
    const dialog = await openBubble(store, threadId, api)

    assert.equal(dialog.open, true)
    // A pull request is visible outside this machine, so the click must not
    // publish anything on its own.
    assert.equal(creates.length, 0)
  })

  it('prefills the title from the thread and names the branch', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const dialog = await openBubble(store, threadId, fakeApi().api)

    assert.equal(
      qsRequired<HTMLInputElement>(dialog, '.create-pr-dialog-title-input').value,
      'Roll up tool activity',
    )
    assert.match(dialog.textContent, /feature\/x/)
  })

  it('asks for a description while the dialog is open, before any confirmation', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, bodyRequests, creates } = fakeApi({ body: 'Rolls tool activity up.' })
    const dialog = await openBubble(store, threadId, api)

    // The inference is the *first* half: it has already run by the time the
    // dialog is on screen, and nothing has been created.
    assert.equal(bodyRequests.length, 1)
    assert.equal(creates.length, 0)
    assert.equal(
      qsRequired<HTMLTextAreaElement>(dialog, '.create-pr-dialog-body-input').value,
      'Rolls tool activity up.',
    )
  })

  it('keeps what the user typed when a late suggestion lands', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    let release: ((body: string | null) => void) | undefined
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base['agent'],
        suggestFollowUps: () => Promise.resolve([CREATE_PR]),
        suggestPrBody: () =>
          new Promise<string | null>((resolve) => {
            release = resolve
          }),
      },
    }
    const dialog = await openBubble(store, threadId, api)

    const body = qsRequired<HTMLTextAreaElement>(dialog, '.create-pr-dialog-body-input')
    body.value = 'my own words'
    body.dispatchEvent(new Event('input'))
    release?.('the model got there second')
    await flush()

    assert.equal(body.value, 'my own words')
  })

  it('creates with the title, body and draft flag, and no further inference', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, creates, bodyRequests } = fakeApi({ body: 'Proposed description.' })
    const dialog = await openBubble(store, threadId, api)

    const draft = qsRequired<HTMLInputElement>(dialog, '.create-pr-dialog-draft-input')
    draft.checked = true
    draft.dispatchEvent(new Event('change'))
    // The button restates the choice, so the draft decision is visible at the
    // moment of committing to it.
    assert.equal(qsRequired(dialog, '.create-pr-dialog-create').textContent, 'Create draft PR')

    qsRequired(dialog, '.create-pr-dialog-create').click()
    await flush()

    const created = creates[0]
    assert.ok(created, 'the confirm should have created exactly one PR')
    assert.deepEqual(created.request, {
      title: 'Roll up tool activity',
      body: 'Proposed description.',
      draft: true,
    })
    assert.equal(created.projectId, 'project-1')
    assert.equal(created.threadId, threadId)
    // Confirming must not spend a second model call: the description was the
    // only inference, and it already happened.
    assert.equal(bodyRequests.length, 1)
    assert.equal(dialog.open, false)
  })

  it('records the create in the transcript as a gh_pr_create card', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api } = fakeApi({ body: 'Proposed description.' })
    const dialog = await openBubble(store, threadId, api)
    qsRequired(dialog, '.create-pr-dialog-create').click()
    await flush()

    const message = lastMessage(store, threadId)
    assert.equal(message.role, 'assistant')
    const call = message.toolCalls[0]
    assert.ok(call, 'the message should carry a tool card')
    assert.equal(call.name, 'gh_pr_create')
    assert.equal(call.status, 'done')
    assert.match(call.result ?? '', /Opened PR #7/)
    // The prose carries it too, so the chat reads as something having happened
    // and not just a bare card.
    assert.match(message.content, /Opened PR #7/)
  })

  it('shows a failed create as an errored card', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api } = fakeApi({
      result: { ok: false, backend: 'cli', message: 'head branch was not pushed' },
    })
    const dialog = await openBubble(store, threadId, api)
    qsRequired(dialog, '.create-pr-dialog-create').click()
    await flush()

    const call = lastMessage(store, threadId).toolCalls[0]
    assert.ok(call, 'the message should carry a tool card')
    assert.equal(call.status, 'error')
    assert.match(call.result ?? '', /not pushed/)
  })

  it('shows a rejected create as an errored card rather than losing it', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api } = fakeApi({ createThrows: true })
    const dialog = await openBubble(store, threadId, api)
    qsRequired(dialog, '.create-pr-dialog-create').click()
    await flush()

    const call = lastMessage(store, threadId).toolCalls[0]
    assert.ok(call, 'the message should carry a tool card')
    assert.equal(call.status, 'error')
    assert.match(call.result ?? '', /gh exploded/)
  })

  it('creates nothing when the dialog is cancelled', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, creates } = fakeApi()
    const dialog = await openBubble(store, threadId, api)

    qsRequired(dialog, '.create-pr-dialog-cancel').click()
    await flush()

    assert.equal(creates.length, 0)
    assert.equal(dialog.open, false)
  })
})
