import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider, ProviderStreamChunk } from './wire-types.ts'
import { withCredentialOutputRedaction } from './credential-output-provider.ts'

const secret = 'rotated-access-secret-123456'
async function collect(chunks: ProviderStreamChunk[]): Promise<ProviderStreamChunk[]> {
  const provider: LLMProvider = {
    async *stream(_messages, _tools, _signal, options) {
      assert.deepEqual(options, { suppressReasoning: true })
      yield* chunks
    },
  }
  const output: ProviderStreamChunk[] = []
  for await (const chunk of withCredentialOutputRedaction(provider, [secret]).stream(
    [],
    [],
    undefined,
    { suppressReasoning: true },
  ))
    output.push(chunk)
  return output
}
describe('credential output boundary', () => {
  it('redacts every possible text and reasoning split before emitting the full credential', async () => {
    for (const type of ['text', 'reasoning'] as const) {
      for (let split = 0; split <= secret.length; split++) {
        const output = await collect([
          { type, text: `before ${secret.slice(0, split)}` },
          { type, text: `${secret.slice(split)} after` },
          { type: 'done' },
        ])
        assert.equal(
          output.map((chunk) => (chunk.type === type ? chunk.text : '')).join(''),
          'before [REDACTED_SECRET] after',
        )
        assert.ok(!JSON.stringify(output).includes(secret))
      }
    }
  })
  it('redacts nested tool arguments and diagnostics without losing usage or optional fields', async () => {
    const output = await collect([
      {
        type: 'tool_call',
        toolCall: {
          id: 'call',
          name: 'write_file',
          title: 'Write the file',
          programmaticName: 'write_file_v2',
          args: { nested: [secret] },
          argsError: secret,
          kind: 'edit',
        },
      },
      {
        type: 'usage',
        model: 'pinned',
        inputTokens: 20,
        outputTokens: 5,
        serviceTierUsage: { flex: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 } },
      },
      {
        type: 'done',
        malformedToolCall: { message: secret, hitOutputCeiling: true, outputTokens: 5 },
      },
    ])
    assert.ok(!JSON.stringify(output).includes(secret))
    // ACP metadata (title, programmaticName, kind) survives the redaction round trip.
    assert.deepEqual(output[0], {
      type: 'tool_call',
      toolCall: {
        id: 'call',
        name: 'write_file',
        title: 'Write the file',
        programmaticName: 'write_file_v2',
        args: { nested: ['[REDACTED_SECRET]'] },
        argsError: '[REDACTED_SECRET]',
        kind: 'edit',
      },
    })
    assert.deepEqual(output[1], {
      type: 'usage',
      model: 'pinned',
      inputTokens: 20,
      outputTokens: 5,
      serviceTierUsage: { flex: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 } },
    })
    assert.deepEqual(output[2], {
      type: 'done',
      malformedToolCall: { message: '[REDACTED_SECRET]', hitOutputCeiling: true, outputTokens: 5 },
    })
  })
  it('redacts thrown diagnostics and replaces the original credential-bearing cause', async () => {
    const original = new Error(`Authentication failed: ${secret}`, {
      cause: { authorization: secret },
    })
    const provider: LLMProvider = {
      stream() {
        throw original
      },
    }
    await assert.rejects(
      async () => {
        for await (const _chunk of withCredentialOutputRedaction(provider, [secret]).stream(
          [],
          [],
        )) {
          // The fixture fails before a response is emitted.
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Authentication failed: [REDACTED_SECRET]')
        assert.ok(error.cause instanceof Error)
        assert.equal(error.cause.message, error.message)
        assert.equal(error.cause.cause, undefined)
        return true
      },
    )
  })

  it('preserves ordinary prose ending with a partial credential prefix', async () => {
    assert.deepEqual(await collect([{ type: 'text', text: 'rotate' }, { type: 'done' }]), [
      { type: 'text', text: 'rotate' },
      { type: 'done' },
    ])
  })
})
