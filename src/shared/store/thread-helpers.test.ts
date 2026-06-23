import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import {
  createThread,
  openNewThread,
  switchThread,
  addMessage,
  addUsageDelta,
  getThreadById,
  isBlankThread,
  hasUnsubmittedPrompt,
  normalizeBlankThreads,
  setThreadDraftPrompt,
} from './thread-helpers.ts'

describe('panel persistence on new thread', () => {
  it('createThread keeps the side/bottom panel open and resets viewer content', () => {
    const store = createStore()
    store.setState({
      filesPaneOpen: true,
      rightPanelMode: 'terminal',
      openFile: { path: 'a.ts', content: 'x', language: 'typescript' },
      activeDiff: { path: 'a.ts', before: 'x', after: 'y', language: 'typescript' },
      stagedDiffs: [{ path: 'a.ts', language: 'typescript' }],
    })

    createThread(store)

    const state = store.getState()
    assert.equal(state.filesPaneOpen, true)
    assert.equal(state.rightPanelMode, 'terminal')
    assert.equal(state.openFile, null)
    assert.equal(state.activeDiff, null)
    assert.deepEqual(state.stagedDiffs, [])
  })

  it('createThread leaves the panel closed when it was already closed', () => {
    const store = createStore()
    store.setState({ filesPaneOpen: false })

    createThread(store)

    assert.equal(store.getState().filesPaneOpen, false)
  })

  it('openNewThread reuse path keeps the panel open and resets viewer content', () => {
    const store = createStore()
    const blankId = createThread(store)
    store.setState({
      filesPaneOpen: true,
      openFile: { path: 'a.ts', content: 'x', language: 'typescript' },
      stagedDiffs: [{ path: 'a.ts', language: 'typescript' }],
    })

    const openedId = openNewThread(store)

    const state = store.getState()
    assert.equal(openedId, blankId)
    assert.equal(state.filesPaneOpen, true)
    assert.equal(state.openFile, null)
    assert.deepEqual(state.stagedDiffs, [])
  })
})

describe('blank thread reuse', () => {
  it('openNewThread reuses an existing blank thread instead of creating another', () => {
    const store = createStore()
    const firstId = createThread(store)
    addMessage(store, firstId, 'user', 'hello')

    const blankId = createThread(store)
    assert.equal(store.getState().threads.length, 2)

    const openedId = openNewThread(store)
    assert.equal(openedId, blankId)
    assert.equal(store.getState().threads.length, 2)
    assert.equal(store.getState().activeThreadId, blankId)
  })

  it('switching away from a blank thread removes unused blanks', () => {
    const store = createStore()
    const usedId = createThread(store)
    addMessage(store, usedId, 'user', 'hello')
    const blankId = createThread(store)

    switchThread(store, usedId)
    assert.equal(
      store.getState().threads.some((t) => t.id === blankId),
      false,
    )
    assert.equal(store.getState().activeThreadId, usedId)
  })

  it('switching away from a blank thread keeps it when it has a draft prompt', () => {
    const store = createStore()
    const usedId = createThread(store)
    addMessage(store, usedId, 'user', 'hello')
    const draftBlankId = createThread(store)
    setThreadDraftPrompt(store, draftBlankId, 'still typing…')

    switchThread(store, usedId)
    const draftBlank = store.getState().threads.find((t) => t.id === draftBlankId)
    assert.ok(draftBlank)
    assert.equal(draftBlank?.draftPrompt, 'still typing…')
    assert.equal(hasUnsubmittedPrompt(draftBlank!), true)
  })

  it('openNewThread creates a new blank when the only blank has a draft', () => {
    const store = createStore()
    const usedId = createThread(store)
    addMessage(store, usedId, 'user', 'hello')
    const draftBlankId = createThread(store)
    setThreadDraftPrompt(store, draftBlankId, 'draft')

    const openedId = openNewThread(store)
    assert.notEqual(openedId, draftBlankId)
    assert.equal(
      store.getState().threads.some((t) => t.id === draftBlankId),
      true,
    )
    assert.equal(store.getState().activeThreadId, openedId)
  })

  it('normalizeBlankThreads collapses multiple blanks on load', () => {
    const store = createStore()
    const blankA = createThread(store)
    const blankB = createThread(store)
    assert.equal(store.getState().threads.length, 2)

    normalizeBlankThreads(store)
    const threads = store.getState().threads
    assert.equal(threads.filter(isBlankThread).length, 1)
    assert.equal(store.getState().activeThreadId, blankB)
    assert.equal(
      threads.some((t) => t.id === blankA),
      false,
    )
  })

  it('addUsageDelta accumulates cache tokens per model and thread total', () => {
    const store = createStore()
    const threadId = createThread(store)

    addUsageDelta(store, threadId, {
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
    })
    addUsageDelta(store, threadId, {
      model: 'claude-opus-4-8',
      inputTokens: 500,
      outputTokens: 20,
      cacheReadTokens: 450,
      cacheCreationTokens: 0,
    })

    const usage = getThreadById(store, threadId)!.usage
    assert.equal(usage.inputTokens, 1500)
    assert.equal(usage.outputTokens, 70)
    assert.equal(usage.cacheReadTokens, 1250)
    assert.equal(usage.cacheCreationTokens, 100)
    assert.deepEqual(usage.byModel?.['claude-opus-4-8'], {
      inputTokens: 1500,
      outputTokens: 70,
      cacheReadTokens: 1250,
      cacheCreationTokens: 100,
    })
  })

  it('addUsageDelta omits cache fields when the provider reports none', () => {
    const store = createStore()
    const threadId = createThread(store)
    addUsageDelta(store, threadId, { model: 'lmstudio:qwen', inputTokens: 300, outputTokens: 30 })

    const usage = getThreadById(store, threadId)!.usage
    assert.equal(usage.inputTokens, 300)
    assert.equal('cacheReadTokens' in usage, false)
    assert.equal('cacheCreationTokens' in usage, false)
  })

  it('normalizeBlankThreads keeps blank threads that have draft prompts', () => {
    const store = createStore()
    const draftBlank = createThread(store)
    setThreadDraftPrompt(store, draftBlank, 'saved draft')
    const emptyA = createThread(store)
    const emptyB = createThread(store)
    assert.equal(store.getState().threads.length, 3)

    normalizeBlankThreads(store)
    const threads = store.getState().threads
    assert.equal(
      threads.some((t) => t.id === draftBlank),
      true,
    )
    assert.equal(threads.filter(isBlankThread).length, 2)
    assert.equal(threads.filter((t) => isBlankThread(t) && !hasUnsubmittedPrompt(t)).length, 1)
    assert.equal(
      threads.some((t) => t.id === emptyA || t.id === emptyB),
      true,
    )
  })
})

describe('draft prompt events', () => {
  it('emits thread_draft_changed (not threads_changed) when saving a draft', () => {
    const store = createStore()
    const id = createThread(store)

    let threadsChanged = 0
    let draftChanged = 0
    let draftChangedId: string | null = null
    store.on('threads_changed', () => threadsChanged++)
    store.on('thread_draft_changed', (tid) => {
      draftChanged++
      draftChangedId = tid
    })

    setThreadDraftPrompt(store, id, 'typing a draft')

    // The conversation rebuild listens to threads_changed; keeping draft saves
    // off that event is what prevents the message list re-rendering per keystroke.
    assert.equal(threadsChanged, 0)
    assert.equal(draftChanged, 1)
    assert.equal(draftChangedId, id)
  })

  it('emits thread_draft_changed when clearing an existing draft', () => {
    const store = createStore()
    const id = createThread(store)
    setThreadDraftPrompt(store, id, 'something')

    let threadsChanged = 0
    let draftChanged = 0
    store.on('threads_changed', () => threadsChanged++)
    store.on('thread_draft_changed', () => draftChanged++)

    setThreadDraftPrompt(store, id, '')

    assert.equal(store.getState().threads.find((t) => t.id === id)?.draftPrompt, undefined)
    assert.equal(threadsChanged, 0)
    assert.equal(draftChanged, 1)
  })

  it('does not emit when the draft is unchanged', () => {
    const store = createStore()
    const id = createThread(store)
    setThreadDraftPrompt(store, id, 'same')

    let draftChanged = 0
    store.on('thread_draft_changed', () => draftChanged++)

    setThreadDraftPrompt(store, id, 'same')
    assert.equal(draftChanged, 0)
  })
})
