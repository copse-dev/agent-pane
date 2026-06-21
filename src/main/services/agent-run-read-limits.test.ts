import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runWithAgentRunReadFileLimits,
  getAgentRunReadFileLimits,
} from './agent-run-read-limits.ts'
import { READ_FILE_LIMITS_CEILING } from '@shared/agent/read-file-limits.ts'

describe('agent-run-read-limits', () => {
  it('returns ceiling when no run is active', () => {
    assert.deepEqual(getAgentRunReadFileLimits(), READ_FILE_LIMITS_CEILING)
  })

  it('scopes limits per async context without cross-run bleed', async () => {
    const parent = { maxChars: 1000, maxLines: 50 }
    const child = { maxChars: 5000, maxLines: 200 }
    await Promise.all([
      runWithAgentRunReadFileLimits(parent, async () => {
        await new Promise((r) => setTimeout(r, 15))
        assert.deepEqual(getAgentRunReadFileLimits(), parent)
      }),
      runWithAgentRunReadFileLimits(child, async () => {
        await new Promise((r) => setTimeout(r, 5))
        assert.deepEqual(getAgentRunReadFileLimits(), child)
      }),
    ])
  })

  it('restores outer limits after nested run', async () => {
    const outer = { maxChars: 2000, maxLines: 80 }
    const inner = { maxChars: 8000, maxLines: 300 }
    await runWithAgentRunReadFileLimits(outer, async () => {
      assert.deepEqual(getAgentRunReadFileLimits(), outer)
      await runWithAgentRunReadFileLimits(inner, async () => {
        assert.deepEqual(getAgentRunReadFileLimits(), inner)
      })
      assert.deepEqual(getAgentRunReadFileLimits(), outer)
    })
  })
})
