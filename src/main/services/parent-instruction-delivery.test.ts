import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CompactionIdentity } from '@copse/llm/provider-state.ts'
import type { ProviderWithUsage } from '@copse/llm/provider-usage.ts'
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamOptions,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'
import { createParentInstructionDelivery } from './parent-instruction-delivery.ts'

function emptyProvider(): LLMProvider {
  return {
    async *stream(): AsyncGenerator<ProviderStreamChunk> {
      yield { type: 'done' }
    },
  }
}

async function drain(stream: AsyncIterable<ProviderStreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // Delivery is observed at the request boundary, independently of its output.
  }
}

describe('parent instruction delivery', () => {
  it('keeps edits deferred when budgeting omits or truncates the leading-system block', async () => {
    const delivery = createParentInstructionDelivery(emptyProvider())
    const block = '<project_instructions>Scoped rules</project_instructions>'
    delivery.requireDelivery(block)

    for (const messages of [
      [{ role: 'system', content: 'Base prompt' }],
      [{ role: 'system', content: block.slice(0, -1) }],
      [{ role: 'user', content: block }],
      [
        { role: 'system', content: 'Base prompt' },
        { role: 'system', content: block },
      ],
    ] satisfies LLMMessage[][]) {
      const before = structuredClone(messages)
      for (const message of messages) Object.freeze(message)
      Object.freeze(messages)
      await drain(delivery.provider.stream(messages, []))
      assert.equal(delivery.hasPendingInstructions, true)
      assert.deepEqual(messages, before, 'the observer must not inject after budgeting')
    }

    const delivered: LLMMessage[] = [{ role: 'system', content: `Base prompt\n\n${block}` }]
    await drain(delivery.provider.stream(delivered, []))
    assert.equal(delivery.hasPendingInstructions, false)
  })

  it('waits for every pending block and permits later discoveries to defer edits again', async () => {
    const delivery = createParentInstructionDelivery(emptyProvider())
    delivery.requireDelivery('First scoped instruction')
    delivery.requireDelivery('Second scoped instruction')
    await drain(
      delivery.provider.stream([{ role: 'system', content: 'First scoped instruction' }], []),
    )
    assert.equal(delivery.hasPendingInstructions, true)
    await drain(
      delivery.provider.stream([{ role: 'system', content: 'Second scoped instruction' }], []),
    )
    assert.equal(delivery.hasPendingInstructions, false)
    delivery.requireDelivery('New scope discovered')
    assert.equal(delivery.hasPendingInstructions, true)
  })

  it('does not release edits for blocks discovered after the current parent request began', async () => {
    const delivery = createParentInstructionDelivery(emptyProvider())
    const system: LLMMessage = { role: 'system', content: 'Base prompt' }
    const currentResponse = delivery.provider.stream([system], [])
    delivery.requireDelivery('New scoped instruction')
    system.content += '\n\nNew scoped instruction'
    await drain(currentResponse)
    assert.equal(delivery.hasPendingInstructions, true)
    await drain(delivery.provider.stream([system], []))
    assert.equal(delivery.hasPendingInstructions, false)
  })

  it('does not let another caller of the shared provider release the parent barrier', async () => {
    const provider = emptyProvider()
    const delivery = createParentInstructionDelivery(provider)
    const messages: LLMMessage[] = [{ role: 'system', content: 'New scoped instruction' }]
    delivery.requireDelivery('New scoped instruction')
    await drain(provider.stream(messages, []))
    assert.equal(delivery.hasPendingInstructions, true)
    await drain(delivery.provider.stream(messages, []))
    assert.equal(delivery.hasPendingInstructions, false)
  })

  it('keeps instructions pending when the request is already aborted', async () => {
    const delivery = createParentInstructionDelivery(emptyProvider())
    const messages: LLMMessage[] = [{ role: 'system', content: 'New scoped instruction' }]
    delivery.requireDelivery('New scoped instruction')
    const controller = new AbortController()
    controller.abort()
    await drain(delivery.provider.stream(messages, [], controller.signal))
    assert.equal(delivery.hasPendingInstructions, true)
    await drain(delivery.provider.stream(messages, []))
    assert.equal(delivery.hasPendingInstructions, false)
  })

  it('preserves receiver, request, tools, signal, options, output and live provider metadata', async () => {
    const messages: LLMMessage[] = [{ role: 'system', content: 'Prompt' }]
    const tools: LLMTool[] = [{ name: 'read_file', description: 'Read a file', parameters: {} }]
    const controller = new AbortController()
    const options: LLMStreamOptions = {
      toolChoice: { name: 'read_file' },
      compactAtTokens: 800,
      suppressReasoning: true,
    }
    const chunks: ProviderStreamChunk[] = [{ type: 'text', text: 'Response' }, { type: 'done' }]
    const output = (async function* (): AsyncGenerator<ProviderStreamChunk> {
      yield* chunks
    })()
    const provider: LLMProvider &
      ProviderWithUsage & { compactionIdentity: CompactionIdentity | undefined } = {
      compactionIdentity: { model: 'model', endpoint: '' },
      lastUsage: { inputTokens: 3, outputTokens: 2 },
      stream(sentMessages, sentTools, signal, streamOptions) {
        assert.equal(this, provider)
        assert.equal(sentMessages, messages)
        assert.equal(sentTools, tools)
        assert.equal(signal, controller.signal)
        assert.equal(streamOptions, options)
        return output
      },
    }
    const delivery = createParentInstructionDelivery(provider)
    assert.equal(delivery.provider.compactionIdentity, provider.compactionIdentity)
    assert.equal(delivery.provider.lastUsage, provider.lastUsage)
    provider.compactionIdentity = undefined
    provider.lastUsage = { inputTokens: 7, outputTokens: 4 }
    assert.equal(delivery.provider.compactionIdentity, undefined)
    assert.equal(delivery.provider.lastUsage, provider.lastUsage)
    const stream = delivery.provider.stream(messages, tools, controller.signal, options)
    assert.equal(stream, output)
    const received: ProviderStreamChunk[] = []
    for await (const chunk of stream) received.push(chunk)
    assert.deepEqual(received, chunks)
    controller.abort()
    assert.equal(controller.signal.aborted, true)
    assert.equal(createParentInstructionDelivery(emptyProvider()).provider.lastUsage, null)
  })
})
