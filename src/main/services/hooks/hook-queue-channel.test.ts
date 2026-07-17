import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AsyncOutcomeRecord } from '@copse/agent/hooks/hook-registry.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { HookQueueMessagePayload } from '@shared/types/hooks.ts'
import {
  forwardHookQueueMessage,
  hookQueueOutcomeSink,
  setHookQueueMessageSender,
} from './hook-queue-channel.ts'

// C2 host bridge (decision 4): an async hook's `queueMessage` outcome is
// translated into the renderer IPC payload with origin (decision 10) + epoch
// (decision 16). Non-`queueMessage` outcomes are dropped here (haltRun routing is
// H3; a stale async haltRun is a suppressed no-op per decision 16).

afterEach(() => {
  setHookQueueMessageSender(null)
})

function record(outcome: AsyncOutcomeRecord['outcome']): AsyncOutcomeRecord {
  return { event: 'stop', hookId: 'todo-closeout', turnTreeId: asTurnTreeId('epoch-7'), outcome }
}

describe('hook-queue-channel', () => {
  it('forwards a queueMessage outcome with origin + epoch', () => {
    const sent: HookQueueMessagePayload[] = []
    setHookQueueMessageSender((p) => sent.push(p))

    forwardHookQueueMessage(
      record({ queueMessage: { text: 'follow up', sendNow: true } }),
      'thread-1',
    )

    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], {
      threadId: 'thread-1',
      text: 'follow up',
      sendNow: true,
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      epoch: 'epoch-7',
    })
  })

  it('drops an outcome with no queueMessage (haltRun routing is H3)', () => {
    const sent: HookQueueMessagePayload[] = []
    setHookQueueMessageSender((p) => sent.push(p))

    forwardHookQueueMessage(record({ haltRun: { reason: 'stop please' } }), 'thread-1')

    assert.equal(sent.length, 0)
  })

  it('is a no-op with no sender wired (headless host)', () => {
    setHookQueueMessageSender(null)
    assert.doesNotThrow(() => {
      forwardHookQueueMessage(record({ queueMessage: { text: 'x', sendNow: false } }), 'thread-1')
    })
  })

  it('hookQueueOutcomeSink binds the thread id', () => {
    const sent: HookQueueMessagePayload[] = []
    setHookQueueMessageSender((p) => sent.push(p))

    const sink = hookQueueOutcomeSink('thread-42')
    sink(record({ queueMessage: { text: 'hi', sendNow: false } }))

    assert.equal(sent[0]?.threadId, 'thread-42')
  })
})
