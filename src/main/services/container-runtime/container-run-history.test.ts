import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerRunProgress, ThreadContainerRecord } from '@shared/types/container-run.ts'
import type { LLMMessage, Message, Thread } from '@shared/types'
import { containerRunToolCall } from '@shared/store/container-run-card.ts'
import { recordContainerRunTurn, type ContainerRunHistoryDeps } from './container-run-history.ts'

const THREAD = 'thread-1'

function record(): ThreadContainerRecord {
  return {
    runtimeId: 'run-1',
    threadId: THREAD,
    startedAt: 1_000,
    finishedAt: 2_000,
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
      egressAllowlist: [],
      hostMounts: [],
    },
    egress: [],
    result: {
      threadId: THREAD,
      stopReason: 'completed',
      usage: { inputTokens: 1, outputTokens: 1 },
      harness: { acp: 'codex-acp' },
      promptsAttempted: 0,
      deferrals: [],
      denials: [],
      commits: [],
      containment: { declared: true, declineReason: null, projectSandbox: false },
      toolNames: [],
      finalText: 'The smoke spec reproduces the slow handshake.',
    },
    transcript: [],
    carryIn: { sha: 'base', dirty: false },
    carryOut: { expected: false, ref: null, error: null },
    containerExit: 0,
    credential: 'key',
    teardown: 'removed',
    cleanupError: null,
    secretCanary: { present: false, detail: 'absent' },
  }
}

function finished(): ContainerRunProgress {
  return {
    threadId: THREAD,
    runtimeId: 'run-1',
    phase: 'finished',
    startedAt: 1_000,
    finishedAt: 2_000,
    prompt: 'Can you run tests e2e and check for regressions from today?',
    model: 'acp:codex-acp',
    egressAllowlist: [],
    credential: 'login',
    log: [],
    warnings: [],
    checkout: null,
    record: record(),
    error: null,
    continuedFrom: null,
  }
}

function deps(
  history: LLMMessage[],
  messages: Message[],
): { deps: ContainerRunHistoryDeps; saved: LLMMessage[][]; forgotten: string[] } {
  const saved: LLMMessage[][] = []
  const forgotten: string[] = []
  const thread: Thread = {
    id: THREAD,
    title: 'T',
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    saved,
    forgotten,
    deps: {
      loadHistory: (): Promise<LLMMessage[]> => Promise.resolve(history),
      saveHistory: (_p, _t, next): Promise<void> => {
        saved.push(next)
        return Promise.resolve()
      },
      loadThread: (): Promise<Thread | null> => Promise.resolve(thread),
      forgetHistory: (_p, threadId): void => {
        forgotten.push(threadId)
      },
    },
  }
}

const roles = (history: LLMMessage[]): string[] => history.map((m) => m.role)

describe('recordContainerRunTurn', () => {
  it('appends the run to a history the dispatcher wrote, prompt and card both', async () => {
    const earlier: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    const d = deps(earlier, [])
    const history = await recordContainerRunTurn('p', finished(), d.deps)
    assert.ok(history)
    assert.deepEqual(roles(history), ['user', 'assistant', 'user', 'assistant', 'tool'])
    const promptTurn = history[2]
    assert.ok(promptTurn?.role === 'user')
    assert.equal(promptTurn.content, finished().prompt)
    const callTurn = history[3]
    assert.ok(callTurn?.role === 'assistant')
    const call = callTurn.content
    assert.ok(Array.isArray(call) && call[0]?.name === 'container_run')
    const result = history[4]
    assert.ok(result?.role === 'tool')
    assert.match(result.toolResults[0]?.result ?? '', /The smoke spec reproduces/)
    assert.deepEqual(d.saved, [history])
    assert.deepEqual(d.forgotten, [THREAD])
  })

  it('rebuilds from the transcript when there is no sidecar, without doubling the card', async () => {
    const progress = finished()
    const card = containerRunToolCall(progress)
    const transcript: Message[] = [
      { id: 'u1', role: 'user', content: progress.prompt, toolCalls: [], createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [card], createdAt: 2 },
    ]
    const d = deps([], transcript)
    const history = await recordContainerRunTurn('p', progress, d.deps)
    assert.ok(history)
    assert.deepEqual(roles(history), ['user', 'assistant', 'tool'])
    // The same when the renderer has not persisted the card yet.
    const notYet = deps([], transcript.slice(0, 1))
    const rebuilt = await recordContainerRunTurn('p', progress, notYet.deps)
    assert.ok(rebuilt)
    assert.deepEqual(roles(rebuilt), ['user', 'assistant', 'tool'])
  })

  it('never throws: a thread that cannot be read is logged, not fatal', async () => {
    const d = deps([], [])
    d.deps.loadHistory = (): Promise<LLMMessage[]> => Promise.reject(new Error('disk'))
    assert.equal(await recordContainerRunTurn('p', finished(), d.deps), null)
    assert.deepEqual(d.saved, [])
  })
})
