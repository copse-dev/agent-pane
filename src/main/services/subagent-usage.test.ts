import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelUsage } from '@shared/types'
import {
  addSubagentUsage,
  getAccumulatedSubagentUsage,
  getSubagentUsageByModel,
  runWithSubagentUsageScope,
} from './subagent-usage.ts'

interface UsageApi {
  enter: <T>(run: () => Promise<T>) => Promise<T>
  add: (usage: ModelUsage) => void
  read: () => ModelUsage
}

const scoped: UsageApi = {
  enter: runWithSubagentUsageScope,
  add: (usage) => {
    addSubagentUsage('worker-a', usage)
  },
  read: getAccumulatedSubagentUsage,
}

/** The pre-fix design: one module-global slot, reset when a run starts. */
function globalSlotApi(): UsageApi {
  let slot: ModelUsage = { inputTokens: 0, outputTokens: 0 }
  return {
    enter<T>(run: () => Promise<T>): Promise<T> {
      slot = { inputTokens: 0, outputTokens: 0 }
      return run()
    },
    add(usage: ModelUsage): void {
      slot.inputTokens += usage.inputTokens
      slot.outputTokens += usage.outputTokens
    },
    read: () => ({ ...slot }),
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/**
 * Two runs whose subagent activity interleaves the way two concurrent
 * threads do: A starts and adds, B starts (the old reset point) and adds,
 * then A adds again and reads its total before B reads.
 */
async function interleavedRuns(api: UsageApi): Promise<{ a: ModelUsage; b: ModelUsage }> {
  const bStarted = gate()
  const aFinished = gate()
  const runA = api.enter(async () => {
    api.add({ inputTokens: 100, outputTokens: 10 })
    await bStarted.wait
    api.add({ inputTokens: 200, outputTokens: 20 })
    const total = api.read()
    aFinished.open()
    return total
  })
  const runB = api.enter(async () => {
    bStarted.open()
    api.add({ inputTokens: 5000, outputTokens: 500 })
    await aFinished.wait
    return api.read()
  })
  const [a, b] = await Promise.all([runA, runB])
  return { a, b }
}

describe('subagent usage accumulator', () => {
  it('keeps each concurrent run to its own subagent usage', async () => {
    const { a, b } = await interleavedRuns(scoped)
    assert.deepEqual(a, { inputTokens: 300, outputTokens: 30 })
    assert.deepEqual(b, { inputTokens: 5000, outputTokens: 500 })
  })

  it('negative control: the same interleaving mixes runs in a global slot', async () => {
    // Proves the schedule above really overlaps the runs. If it did not,
    // the scoped test would pass for any implementation.
    const { a, b } = await interleavedRuns(globalSlotApi())
    assert.notDeepEqual(a, { inputTokens: 300, outputTokens: 30 })
    assert.notDeepEqual(b, { inputTokens: 5000, outputTokens: 500 })
    assert.deepEqual(a, { inputTokens: 5200, outputTokens: 520 })
  })

  it('drops usage added outside any run instead of crediting a later run', async () => {
    addSubagentUsage('worker-a', { inputTokens: 999, outputTokens: 99 })
    assert.deepEqual(getAccumulatedSubagentUsage(), { inputTokens: 0, outputTokens: 0 })
    const total = await runWithSubagentUsageScope(async () => getAccumulatedSubagentUsage())
    assert.deepEqual(total, { inputTokens: 0, outputTokens: 0 })
  })

  it('sums cache token fields only when a subagent reports them', async () => {
    const total = await runWithSubagentUsageScope(async () => {
      addSubagentUsage('worker-a', { inputTokens: 1, outputTokens: 1 })
      addSubagentUsage('worker-a', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 7 })
      addSubagentUsage('worker-a', {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      })
      return getAccumulatedSubagentUsage()
    })
    assert.deepEqual(total, {
      inputTokens: 3,
      outputTokens: 3,
      cacheReadTokens: 10,
      cacheCreationTokens: 4,
    })
  })

  it('keeps mixed model totals separate and returns independent snapshots', () => {
    runWithSubagentUsageScope(() => {
      addSubagentUsage('small-local', { inputTokens: 30, outputTokens: 4, cacheReadTokens: 7 })
      addSubagentUsage('other-worker', { inputTokens: 20, outputTokens: 3, cacheCreationTokens: 5 })
      addSubagentUsage('small-local', { inputTokens: 10, outputTokens: 2 })
      const byModel = getSubagentUsageByModel()
      assert.deepEqual(
        [...byModel],
        [
          ['small-local', { inputTokens: 40, outputTokens: 6, cacheReadTokens: 7 }],
          ['other-worker', { inputTokens: 20, outputTokens: 3, cacheCreationTokens: 5 }],
        ],
      )
      const first = byModel.get('small-local')
      assert.ok(first)
      first.inputTokens = 900
      byModel.clear()
      assert.deepEqual(getAccumulatedSubagentUsage(), {
        inputTokens: 60,
        outputTokens: 9,
        cacheReadTokens: 7,
        cacheCreationTokens: 5,
      })
    })
    assert.equal(getSubagentUsageByModel().size, 0)
  })
})
