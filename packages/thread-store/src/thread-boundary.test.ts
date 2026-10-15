import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseThreadMetaValue } from './thread-boundary.ts'

function meta(usage: unknown): Record<string, unknown> {
  return { id: 't1', title: 'Thread', status: 'idle', usage, createdAt: 1, updatedAt: 2 }
}

describe('parseThreadMetaValue usage', () => {
  it('round-trips the thread execution choice and defaults unknown values to Copse managed', () => {
    const base = meta({ inputTokens: 0, outputTokens: 0 })
    assert.deepEqual(
      parseThreadMetaValue({ ...base, executionMode: 'agent' })?.executionMode,
      'agent',
    )
    const unknown = parseThreadMetaValue({ ...base, executionMode: 'other' })
    assert.ok(unknown)
    assert.equal(Object.hasOwn(unknown, 'executionMode'), false)
  })

  it('raises legacy fresh-only ACP byModel entries and the thread total to the cache floor, once', () => {
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
    // A running total cannot say how much of it was fresh, so the entry rises to
    // its cache total (41,200), not the exact 41,203 a single event would get.
    assert.equal(parsed.usage.inputTokens, 42_200)
    assert.deepEqual(byModel['acp:claude-acp#opus'], {
      inputTokens: 41_200,
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

  it('never overstates an entry that mixes legacy and normalised ACP turns', () => {
    // Legacy turn: 3 fresh + 40 cache recorded as input 3. Normalised turn: 40
    // input, all of it cache. The merged entry is input 43 / cache 80, and the
    // true input is 83; adding the whole cache again would claim 123.
    const parsed = parseThreadMetaValue(
      meta({
        inputTokens: 43,
        outputTokens: 2,
        byModel: {
          'acp:claude-acp#opus': { inputTokens: 43, outputTokens: 2, cacheReadTokens: 80 },
        },
      }),
    )
    const input = parsed?.usage.byModel?.['acp:claude-acp#opus']?.inputTokens
    assert.equal(input, 80)
    assert.equal(parsed?.usage.inputTokens, 80)
  })

  it('does not coerce malformed persisted cache counts into repaired input', () => {
    for (const cache of [{ cacheReadTokens: '40' }, { cacheCreationTokens: '20' }]) {
      const parsed = parseThreadMetaValue(
        meta({
          inputTokens: 3,
          outputTokens: 2,
          byModel: {
            'acp:claude-acp#opus': { inputTokens: 3, outputTokens: 2, ...cache },
          },
        }),
      )
      assert.ok(parsed)
      assert.equal(parsed.usage.inputTokens, 3)
      assert.equal(parsed.usage.byModel?.['acp:claude-acp#opus']?.inputTokens, 3)
    }
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
