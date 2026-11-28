import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { ApprovalRequest } from '../approval.ts'
import { admitted } from './host-admission.ts'
import type { TurnHostLinkDependencies } from './turn-host-link.ts'
import type { HostInferRequest, HostToApp } from './turn-host-protocol.ts'

const REQUEST: ApprovalRequest = {
  title: 'Run npm test?',
  body: 'npm test',
  type: 'shell',
  workspaceTrustOffer: { root: '/Users/me/secrets' },
  toolCallId: 'tool-1',
  bridgeExecutionId: 'bridge-1',
}

function approval(threadId: string, projectId = 'p1'): Extract<HostToApp, { t: 'approval' }> {
  return { t: 'approval', id: 'a1', projectId, threadId, request: REQUEST }
}

function call(threadId: string): HostInferRequest {
  return {
    t: 'infer',
    id: 'c1',
    threadId,
    model: 'm',
    providerOptions: {},
    messages: [],
    tools: [],
  }
}

/** A link's handlers that record what reached them. */
function handlers(): {
  deps: TurnHostLinkDependencies
  reached: string[]
  shown: ApprovalRequest[]
} {
  const reached: string[] = []
  const shown: ApprovalRequest[] = []
  const deps: TurnHostLinkDependencies = {
    version: '1',
    connect: () => Promise.resolve(null),
    readRecord: () => Promise.resolve(null),
    isAlive: () => true,
    settleUncertain: () => Promise.resolve(),
    askUser: (prompt) => {
      shown.push(prompt.request)
      return Promise.resolve({ approved: true, remember: false })
    },
    infer: async function* (): AsyncIterable<ProviderStreamChunk> {
      reached.push('infer')
      await Promise.resolve()
      yield* []
    },
    onUnfollowedChunk: (message) => {
      reached.push(`chunk ${message.threadId}`)
    },
    onInstructionActivation: (_projectKey, threadId) => {
      reached.push(`instructions ${threadId}`)
    },
    onShellOutput: () => {
      reached.push('shell')
    },
  }
  return { deps, reached, shown }
}

describe('what a host on another machine may act for', () => {
  const admission = {
    thread: (threadId: string, projectId?: string): boolean =>
      threadId === 't1' && (projectId === undefined || projectId === 'p1'),
    call: (request: HostInferRequest): string | null =>
      request.threadId === 't1' ? null : 'no turn of that thread',
  }

  it('asks only for its own turn, and never offers to trust a folder it names', async () => {
    const { deps, shown } = handlers()
    const gated = admitted(deps, admission)
    const signal = new AbortController().signal
    await gated.askUser?.(approval('t1'), signal)
    await assert.rejects(gated.askUser?.(approval('t2'), signal) ?? Promise.resolve(), /no turn/)
    await assert.rejects(
      gated.askUser?.(approval('t1', 'p2'), signal) ?? Promise.resolve(),
      /no turn/,
    )
    assert.equal(shown.length, 1)
    assert.deepEqual(shown[0], { title: 'Run npm test?', body: 'npm test', type: 'shell' })
  })

  it('makes model calls, and shows output, only for what it is admitted to', async () => {
    const { deps, reached } = handlers()
    const gated = admitted(deps, admission)
    const signal = new AbortController().signal
    const chunks: ProviderStreamChunk[] = []
    for await (const chunk of gated.infer?.(call('t1'), signal) ?? []) chunks.push(chunk)
    assert.throws(() => gated.infer?.(call('t2'), signal), /no turn of that thread/)
    const chunk = { type: 'text', text: 'x' } as const
    gated.onUnfollowedChunk?.({ t: 'chunk', threadId: 't1', chunk })
    gated.onUnfollowedChunk?.({ t: 'chunk', threadId: 't2', chunk })
    gated.onInstructionActivation?.('p1', 't2', ['AGENTS.md'])
    assert.equal(gated.onShellOutput, undefined)
    assert.deepEqual(reached, ['infer', 'chunk t1'])
  })
})
