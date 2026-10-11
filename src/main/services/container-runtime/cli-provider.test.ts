import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { buildCliProvider, parseOutputLimit } from './cli-provider.ts'

describe('CLI provider output limit', () => {
  it('validates explicit limits and uses a bounded default', () => {
    assert.equal(parseOutputLimit(undefined), 16_384)
    assert.equal(parseOutputLimit('8192'), 8192)
    for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])
      assert.throws(() => parseOutputLimit(value), /positive safe integer/)
  })

  it('sends a per-response cap while preserving a smaller remaining run budget', async () => {
    for (const [remainingTokens, outputLimit, expected] of [
      [500_000, 16_384, 16_384],
      [500_000, 8192, 8192],
      [2000, 16_384, 2000],
    ]) {
      assert.ok(remainingTokens !== undefined && outputLimit !== undefined)
      let observed: number | undefined
      const provider = buildCliProvider({
        model: 'qwen3.8-27b',
        url: 'https://api.scaleway.ai/v1',
        apiKey: 'test-key',
        remainingTokens,
        outputLimit,
        fetch: async (input, init) => {
          const body = await new Request(input, init).text()
          const request = safeJsonParse(
            body,
            decodeWithSchema(z.object({ max_tokens: z.number() })),
          )
          assert.ok(request)
          observed = request.max_tokens
          return new Response('data: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        },
      })
      for await (const _chunk of provider.stream([], [])) {
        /* drain the response */
      }
      assert.equal(observed, expected)
    }
  })
})
