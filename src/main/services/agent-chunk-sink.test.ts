import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentHost } from '@shared/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import { createAgentChunkSink } from './agent-chunk-sink.ts'
import { getThreadModels } from './thread-models.ts'
import { getUsageEventCount } from './usage-ledger.ts'
import { storageSet } from './storage.ts'
import { USAGE_EVENTS_STORAGE_KEY } from '@shared/usage/usage-event.ts'

describe('createAgentChunkSink', () => {
  it('records usage ledger events and thread models for usage chunks', () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    storageSet('activeProjectId', 'proj-1')
    const emitted: StreamChunk[] = []
    const host: AgentHost = { emit: (_threadId, chunk) => emitted.push(chunk) }
    const sink = createAgentChunkSink('thread-1', host)

    sink({
      type: 'usage',
      model: 'qwen/qwen3.6-35b-a3b',
      inputTokens: 100,
      outputTokens: 20,
    })
    sink({ type: 'text', text: 'hi' })

    assert.equal(getUsageEventCount(), 1)
    assert.deepEqual(getThreadModels('thread-1'), ['qwen/qwen3.6-35b-a3b'])
    assert.deepEqual(emitted, [
      {
        type: 'usage',
        model: 'qwen/qwen3.6-35b-a3b',
        inputTokens: 100,
        outputTokens: 20,
      },
      { type: 'text', text: 'hi' },
    ])
  })
})
