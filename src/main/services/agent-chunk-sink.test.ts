import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import { createAgentChunkSink } from './agent-chunk-sink.ts'
import { getThreadModels } from './thread-models.ts'
import { getUsageEventCount, readUsageEvents } from './storage/usage-ledger.ts'
import { storageSet } from './storage/storage.ts'
import { clearUsageLedger } from './storage/usage-ledger.test-support.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'

describe('createAgentChunkSink', () => {
  it('records usage ledger events and thread models for usage chunks', async () => {
    await clearUsageLedger()
    storageSet('activeProjectId', 'proj-1')
    const emitted: StreamChunk[] = []
    const host: AgentHost<StreamChunk> = { emit: (_threadId, chunk) => emitted.push(chunk) }
    const sink = createAgentChunkSink('thread-1', host)

    sink({
      type: 'usage',
      model: 'qwen/qwen3.6-35b-a3b',
      inputTokens: 100,
      outputTokens: 20,
    })
    sink({ type: 'text', text: 'hi' })

    assert.equal(await getUsageEventCount(), 1)
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

  it('records advisor usageSource on the ledger for dedicated advisor cost lines', async () => {
    await clearUsageLedger()
    storageSet('activeProjectId', 'proj-1')
    const host: AgentHost<StreamChunk> = { emit: () => undefined }
    const sink = createAgentChunkSink('thread-adv', host)

    sink({
      type: 'usage',
      model: 'claude-opus-4-8',
      inputTokens: 900,
      outputTokens: 40,
      usageSource: 'advisor',
    })

    assert.equal(await getUsageEventCount(), 1)
    const event = (await readUsageEvents())[0]
    assert.ok(event)
    assert.equal(event.source, 'advisor')
    assert.equal(event.model, 'claude-opus-4-8')
  })

  it('persists requested and actual service-tier evidence for ledger pricing', async () => {
    await clearUsageLedger()
    const host: AgentHost<StreamChunk> = { emit: () => undefined }
    const sink = createAgentChunkSink('thread-tier', host)

    sink({
      type: 'usage',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 20,
      requestedServiceTier: 'flex',
      responseServiceTier: 'priority',
    })

    const [event] = await readUsageEvents()
    if (event === undefined) assert.fail('expected a persisted usage event')
    assert.equal(event.requestedServiceTier, 'flex')
    assert.equal(event.responseServiceTier, 'priority')
  })

  it('records usage against the execution context project for background runs', async () => {
    await clearUsageLedger()
    storageSet('activeProjectId', 'project-being-viewed')
    const host: AgentHost<StreamChunk> = { emit: () => undefined }
    const sink = createAgentChunkSink('thread-background', host)

    runWithThreadExecutionContext(
      {
        projectId: 'project-owning-run',
        threadId: 'thread-background',
        projectRoot: '/project',
        root: '/project',
        checkoutMode: 'shared',
        branch: null,
      },
      () => {
        sink({
          type: 'usage',
          model: 'openrouter:z-ai/glm-5.3-flash',
          inputTokens: 1000,
          outputTokens: 100,
        })
      },
    )

    const event = (await readUsageEvents())[0]
    assert.ok(event)
    assert.equal(event.projectId, 'project-owning-run')
  })

  it('keeps equal-sized usage chunks from distinct billed calls', async () => {
    await clearUsageLedger()
    const host: AgentHost<StreamChunk> = { emit: () => undefined }
    const sink = createAgentChunkSink('thread-1', host)
    const usage: StreamChunk = {
      type: 'usage',
      model: 'openrouter:z-ai/glm-5.3-flash',
      inputTokens: 1000,
      outputTokens: 100,
    }

    sink(usage)
    sink(usage)

    assert.equal(await getUsageEventCount(), 2)
  })
})
