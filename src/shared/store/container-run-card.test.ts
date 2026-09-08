import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerRunProgress, ThreadContainerRecord } from '../types/container-run.ts'
import type { Thread } from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'
import { createStore } from './store.ts'
import {
  CONTAINER_RUN_TOOL,
  containerRunResultMarkdown,
  containerRunSummary,
  containerRunToolCall,
  containerRunToolCallId,
  noteAdoptionOnCard,
  syncContainerRunCard,
} from './container-run-card.ts'

const THREAD = 'thread-1'

function progress(overrides: Partial<ContainerRunProgress> = {}): ContainerRunProgress {
  return {
    threadId: THREAD,
    runtimeId: null,
    phase: 'preparing',
    startedAt: 1_000,
    finishedAt: null,
    prompt: 'Fix the lint backlog',
    model: 'claude-sonnet-4-6',
    egressAllowlist: ['api.anthropic.com:443'],
    credential: 'key',
    log: [],
    warnings: [],
    checkout: null,
    record: null,
    error: null,
    ...overrides,
  }
}

function record(overrides: Partial<ThreadContainerRecord> = {}): ThreadContainerRecord {
  return {
    runtimeId: 'run-1',
    threadId: THREAD,
    startedAt: 1_000,
    finishedAt: 61_000,
    image: 'copse-worker:test',
    imageDigest: null,
    attestation: {
      runtimeId: 'run-1',
      image: 'copse-worker:test',
      user: 1001,
      readOnlyRootfs: true,
      capDropAll: true,
      noNewPrivileges: true,
      pidsLimit: 512,
      memoryLimit: '4g',
      network: 'brokered',
      egressAllowlist: ['api.anthropic.com:443'],
      hostMounts: [],
    },
    egress: [],
    result: {
      threadId: THREAD,
      stopReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 5 },
      harness: 'copse',
      promptsAttempted: 0,
      deferrals: [{ id: 'd1', title: 'Push', subject: 'git push', reasons: ['publishes'] }],
      denials: [],
      commits: ['abc fix: the thing'],
      containment: { declared: true, declineReason: null, projectSandbox: false },
      toolNames: [],
      finalText: 'Done.',
    },
    transcript: [
      { id: 'g1', role: 'assistant', content: 'Looking.', toolCalls: [], createdAt: 2_000 },
    ],
    carryIn: { sha: 'base', dirty: false },
    carryOut: { expected: true, ref: 'refs/copse/runs/run-1', error: null },
    containerExit: 0,
    credential: 'key',
    teardown: 'removed',
    cleanupError: null,
    secretCanary: { present: false, detail: 'absent' },
    ...overrides,
  }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD,
    title: 'Lint',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('containerRunToolCall', () => {
  it('is a running container card while the run is live, with the log as its timeline', () => {
    const tc = containerRunToolCall(
      progress({ phase: 'running', runtimeId: 'run-1', log: ['[worker] hello'] }),
    )
    assert.equal(tc.id, containerRunToolCallId(progress()))
    assert.equal(tc.name, CONTAINER_RUN_TOOL)
    assert.equal(tc.status, 'running')
    assert.equal(tc.result, null)
    assert.deepEqual(tc.args, {
      task: 'Fix the lint backlog',
      model: 'claude-sonnet-4-6',
      runtimeId: 'run-1',
      ref: null,
    })
    assert.ok(tc.subagent)
    assert.equal(tc.subagent.kind, 'container')
    assert.equal(tc.subagent.status, 'running')
    assert.equal(tc.subagent.summary, null)
    assert.deepEqual(
      tc.subagent.messages.map((m) => m.content),
      ['```text\n[worker] hello\n```'],
    )
  })

  it('settles into the record: transcript as the timeline, the review as the result', () => {
    const finished = progress({
      phase: 'finished',
      runtimeId: 'run-1',
      finishedAt: 61_000,
      log: ['[thread-container] carry-out fetched'],
      warnings: ['1 connection refused by the egress allowlist: evil.example:443'],
      record: record(),
    })
    const tc = containerRunToolCall(finished)
    assert.equal(tc.status, 'done')
    assert.ok(tc.subagent)
    assert.equal(tc.subagent.status, 'done')
    assert.equal(
      containerRunSummary(finished),
      'Finished: 1 commit on refs/copse/runs/run-1, 1 effect waiting for review, 0 effects refused.',
    )
    assert.deepEqual(
      tc.subagent.messages.map((m) => m.id),
      ['g1', 'run-log'],
    )
    assert.deepEqual(tc.subagent.usage, { inputTokens: 10, outputTokens: 5 })
    const markdown = containerRunResultMarkdown(finished) ?? ''
    assert.equal(tc.result, markdown)
    assert.equal(tc.resultFormat, 'markdown')
    assert.match(markdown, /^\*\*Finished: 1 commit on refs\/copse\/runs\/run-1/)
    assert.match(markdown, /Copse harness · 10 in \/ 5 out · 60s/)
    assert.match(markdown, /- `abc fix: the thing`/)
    assert.match(markdown, /\*\*Needs your attention\*\*\n- 1 connection refused/)
    assert.match(markdown, /\*\*Waiting for your review\*\*\n- Push — publishes/)
    assert.match(markdown, /\nDone\.$/)
    assert.equal(isRecord(tc.args) ? tc.args['ref'] : undefined, 'refs/copse/runs/run-1')
  })

  it('is an error card for a failed run, saying why', () => {
    const failed = progress({ phase: 'failed', error: 'The guest wrote no result' })
    const tc = containerRunToolCall(failed)
    assert.equal(tc.status, 'error')
    assert.ok(tc.subagent)
    assert.equal(tc.subagent.status, 'error')
    assert.equal(containerRunSummary(failed), 'Failed: The guest wrote no result')
    assert.match(tc.result ?? '', /^\*\*Failed: The guest wrote no result\*\*/)
  })
})

describe('syncContainerRunCard', () => {
  it('adds one assistant message the first time and updates the same card after', () => {
    const store = createStore()
    store.setState({ threads: [thread()], activeThreadId: THREAD })
    assert.equal(syncContainerRunCard(store, progress()), 'added')
    assert.equal(syncContainerRunCard(store, progress({ phase: 'running' })), 'updated')
    assert.equal(
      syncContainerRunCard(store, progress({ phase: 'finished', record: record() })),
      'updated',
    )
    const messages = store.getState().threads[0]?.messages ?? []
    assert.equal(messages.length, 1)
    const message = messages[0]
    assert.ok(message)
    assert.equal(message.role, 'assistant')
    assert.equal(message.content, '')
    const card = message.toolCalls[0]
    assert.ok(card)
    assert.equal(message.toolCalls.length, 1)
    assert.equal(card.status, 'done')
    assert.equal(card.subagent?.kind, 'container')
  })

  it('leaves a thread whose transcript is not in memory alone', () => {
    const store = createStore()
    store.setState({
      threads: [thread({ messagesLoaded: false })],
      activeThreadId: THREAD,
    })
    assert.equal(syncContainerRunCard(store, progress()), 'skipped')
    assert.equal(syncContainerRunCard(store, progress({ threadId: 'elsewhere' })), 'skipped')
    assert.equal(store.getState().threads[0]?.messages.length, 0)
  })

  it('notes a follow-up on the card, whether commits were applied or already there', () => {
    const store = createStore()
    store.setState({ threads: [thread()], activeThreadId: THREAD })
    const finished = progress({ phase: 'finished', record: record() })
    syncContainerRunCard(store, finished)
    const id = containerRunToolCallId(finished)
    noteAdoptionOnCard(store, THREAD, id, { applied: ['abc fix: the thing'], alreadyApplied: 0 })
    const result = (): string =>
      store.getState().threads[0]?.messages[0]?.toolCalls[0]?.result ?? ''
    assert.match(result(), /\n\n\*\*Applied to this checkout:\*\* 1 commit$/)
    noteAdoptionOnCard(store, THREAD, id, { applied: [], alreadyApplied: 1 })
    assert.match(result(), /\*\*Already in this checkout\*\* \(1 commit\)\.$/)
    // A card that is not there is not invented.
    noteAdoptionOnCard(store, THREAD, 'nope', { applied: [], alreadyApplied: 0 })
    assert.equal(store.getState().threads[0]?.messages.length, 1)
  })
})
