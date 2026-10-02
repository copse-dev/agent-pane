import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseThreadMetaValue } from './thread-boundary.ts'

function meta(usage: unknown): unknown {
  return { id: 't1', title: 'Thread', status: 'idle', usage, createdAt: 1, updatedAt: 2 }
}

describe('parseThreadMetaValue usage', () => {
  it('repairs legacy fresh-only ACP byModel entries and the thread total, once', () => {
    const parsed = parseThreadMetaValue(
      meta({
        inputTokens: 1_003,
        outputTokens: 130,
        cacheReadTokens: 40_000,
        cacheCreationTokens: 1_200,
        byModel: {
          'acp:claude-acp#opus': {
            inputTokens: 3,
            outputTokens: 120,
            cacheReadTokens: 40_000,
            cacheCreationTokens: 1_200,
          },
          'claude-sonnet-4-6': { inputTokens: 1_000, outputTokens: 10 },
        },
      }),
    )
    assert.ok(parsed)
    const { byModel } = parsed.usage
    assert.ok(byModel)
    assert.equal(parsed.usage.inputTokens, 42_203)
    assert.deepEqual(byModel['acp:claude-acp#opus'], {
      inputTokens: 41_203,
      outputTokens: 120,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 1_200,
    })
    assert.deepEqual(byModel['claude-sonnet-4-6'], {
      inputTokens: 1_000,
      outputTokens: 10,
    })
    // The repaired meta is what the next save persists; reading it back is a no-op.
    const reread = parseThreadMetaValue(JSON.parse(JSON.stringify(parsed)))
    assert.deepEqual(reread?.usage, parsed.usage)
  })

  it('leaves usage without legacy ACP entries untouched', () => {
    const usage = {
      inputTokens: 41_203,
      outputTokens: 120,
      byModel: {
        'acp:claude-acp#opus': { inputTokens: 41_203, outputTokens: 120, cacheReadTokens: 40_000 },
      },
    }
    assert.deepEqual(parseThreadMetaValue(meta(usage))?.usage, usage)
  })
})
