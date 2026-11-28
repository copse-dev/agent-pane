import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'
import type { HostToApp } from './turn-host-protocol.ts'
import { HostApprovals } from './host-approvals.ts'

const childThread: Thread = {
  id: 'child',
  title: 'Build checks',
  status: 'idle',
  model: 'claude-sonnet-4-6',
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  createdAt: 0,
  updatedAt: 0,
}

const request = { title: 'Run ls?', body: 'ls', type: 'shell' as const }

function approvals(): { approvals: HostApprovals; sent: HostToApp[] } {
  const sent: HostToApp[] = []
  let next = 0
  return {
    approvals: new HostApprovals(
      (message) => sent.push(message),
      () => `a${String(++next)}`,
    ),
    sent,
  }
}

describe('HostApprovals', () => {
  it('settles a prompt with the first answer and takes it down everywhere', async () => {
    const { approvals: prompts, sent } = approvals()
    const asked = prompts.ask('p1', 't1', request)
    assert.deepEqual(sent, [{ t: 'approval', id: 'a1', projectId: 'p1', threadId: 't1', request }])
    prompts.answer('a1', { approved: true, remember: true, grantScope: 'turn-tree' })
    prompts.answer('a1', { approved: false, remember: false })
    assert.deepEqual(await asked, {
      approved: true,
      remember: true,
      grantScope: 'turn-tree',
      resolution: 'user',
    })
    assert.deepEqual(sent.at(-1), { t: 'approval-cancel', id: 'a1' })
    assert.equal(prompts.pendingCount(), 0)
  })

  it('denies a prompt whose turn was stopped', async () => {
    const { approvals: prompts, sent } = approvals()
    const controller = new AbortController()
    const asked = prompts.ask('p1', 't1', request, controller.signal)
    controller.abort()
    assert.equal((await asked).approved, false)
    assert.deepEqual(sent.at(-1), { t: 'approval-cancel', id: 'a1' })
    controller.abort()
    assert.equal((await prompts.ask('p1', 't1', request, controller.signal)).approved, false)
    assert.equal(sent.length, 2, 'a stopped turn asks nothing')
  })

  it('asks an app that attaches every prompt still open', () => {
    const { approvals: prompts } = approvals()
    void prompts.ask('p1', 't1', request)
    void prompts.ask('p1', 't2', request)
    prompts.answer('a1', { approved: false, remember: false })
    const replayed: HostToApp[] = []
    prompts.replay((message) => replayed.push(message))
    assert.deepEqual(
      replayed.map((m) => (m.t === 'approval' ? m.threadId : m.t)),
      ['t2'],
    )
  })

  it('asks the diff panel and the SSH dialog, each answered in kind', async () => {
    const { approvals: prompts, sent } = approvals()
    const entry = { path: 'a.txt', before: 'a', after: 'b', language: 'plaintext' }
    const reviewed = prompts.reviewDiff('p1', 't1', entry)
    const asked = prompts.askSsh('p1', 't1', { prompt: 'Password:', kind: 'secret' })
    assert.deepEqual(
      sent.map((m) => m.t),
      ['review-diff', 'ssh-prompt'],
    )
    // An answer of the wrong kind settles nothing.
    prompts.answer('a1', { approved: true, remember: false })
    prompts.answerSsh('a1', { value: 'nope' })
    assert.equal(prompts.pendingCount(), 2)
    prompts.answerDiff('a1', true)
    prompts.answerSsh('a2', { value: 'hunter2' })
    assert.equal(await reviewed, true)
    assert.deepEqual(await asked, { value: 'hunter2' })
  })

  it("has the window send a host turn's prompt to another thread", async () => {
    const { approvals: prompts, sent } = approvals()
    const command = {
      sourceThreadId: 't1',
      projectId: 'p1',
      thread: childThread,
      text: 'Check the build.',
      authorizingAccess: 'orchestrate' as const,
    }
    const result = prompts.sendThreadPrompt('p1', 't1', command)
    assert.deepEqual(sent, [
      { t: 'thread-prompt', id: 'a1', projectId: 'p1', threadId: 't1', command },
    ])
    prompts.answer('a1', { approved: true, remember: false })
    prompts.answerThreadPrompt('a1', { ok: true, queued: false })
    assert.deepEqual(await result, { ok: true, queued: false })

    const controller = new AbortController()
    const stopped = prompts.sendThreadPrompt('p1', 't1', command, controller.signal)
    controller.abort()
    assert.deepEqual(await stopped, { ok: false, error: 'Sending was cancelled.' })
  })

  it("puts a host turn's own questions to the window, and withdraws them on Stop", async () => {
    const { approvals: prompts, sent } = approvals()
    const request = { questions: [{ question: 'Which branch?', options: ['main', 'dev'] }] }
    const answered = prompts.askQuestions('p1', 't1', request)
    assert.deepEqual(sent, [{ t: 'ask-user', id: 'a1', projectId: 'p1', threadId: 't1', request }])
    prompts.answerThreadPrompt('a1', { ok: true, queued: false })
    prompts.answerQuestions('a1', { answers: ['dev'] })
    assert.deepEqual(await answered, { answers: ['dev'] })

    const controller = new AbortController()
    const stopped = prompts.askQuestions('p1', 't1', request, controller.signal)
    controller.abort()
    assert.deepEqual(await stopped, { answers: [''], cancelled: true })
    assert.deepEqual(sent.at(-1), { t: 'approval-cancel', id: 'a2' })
  })

  it('rejects a staged edit whose turn was stopped', async () => {
    const { approvals: prompts } = approvals()
    const controller = new AbortController()
    const entry = { path: 'a.txt', before: 'a', after: 'b', language: 'plaintext' }
    const reviewed = prompts.reviewDiff('p1', 't1', entry, controller.signal)
    controller.abort()
    assert.equal(await reviewed, false)
  })
})
