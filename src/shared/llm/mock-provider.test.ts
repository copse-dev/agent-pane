import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockLLMProvider } from './mock-provider.ts'
import type { LLMMessage, LLMTool } from '@shared/types'

async function collectChunks(provider: MockLLMProvider, messages: LLMMessage[], tools: LLMTool[]) {
  const chunks = []
  for await (const chunk of provider.stream(messages, tools)) {
    chunks.push(chunk)
  }
  return chunks
}

describe('MockLLMProvider', () => {
  it('issues a tool call on the first assistant turn when tools exist', async () => {
    const provider = new MockLLMProvider()
    const tools: LLMTool[] = [{ name: 'list_dir', description: 'list', parameters: {} }]
    const chunks = await collectChunks(
      provider,
      [{ role: 'user', content: 'hello workspace' }],
      tools,
    )
    assert.ok(chunks.some((c) => c.type === 'tool_call' && c.toolCall.name === 'list_dir'))
    assert.equal(chunks.at(-1)?.type, 'done')
  })

  it('returns mock text on later turns without another tool call', async () => {
    const provider = new MockLLMProvider()
    const tools: LLMTool[] = [{ name: 'list_dir', description: 'list', parameters: {} }]
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello workspace' },
      { role: 'assistant', content: [{ id: '1', name: 'list_dir', args: { path: '.' } }] },
      { role: 'tool', toolResults: [{ toolCallId: '1', result: 'ok' }] },
    ]
    const chunks = await collectChunks(provider, messages, tools)
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
    assert.match(text, /Mock response to:/)
    assert.ok(!chunks.some((c) => c.type === 'tool_call'))
  })
  it('honors [[mcp:write_file]] on a later user turn', async () => {
    const provider = new MockLLMProvider()
    const tools: LLMTool[] = [{ name: 'write_file', description: 'write', parameters: {} }]
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ id: '1', name: 'list_dir', args: { path: '.' } }] },
      { role: 'tool', toolResults: [{ toolCallId: '1', result: 'ok' }] },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '[[mcp:write_file {"path":"a.ts","content":"x"}]]' },
    ]
    const chunks = await collectChunks(provider, messages, tools)
    assert.ok(chunks.some((c) => c.type === 'tool_call' && c.toolCall.name === 'write_file'))
  })
})
