import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TERMINAL_BENCH_HELD_OUT_TASKS,
  TERMINAL_BENCH_HISTORICAL_TASKS,
  terminalBenchHeldOutTasks,
} from './terminal-bench-ablation.mts'

describe('Terminal-Bench 2.1 ablation cohorts', () => {
  it('keeps the historical development cohort separate from held-out tasks', () => {
    assert.equal(TERMINAL_BENCH_HISTORICAL_TASKS.length, 4)
    assert.equal(TERMINAL_BENCH_HELD_OUT_TASKS.length, 12)
    const historical = new Set<string>(TERMINAL_BENCH_HISTORICAL_TASKS)
    assert.equal(
      TERMINAL_BENCH_HELD_OUT_TASKS.some((task) => historical.has(task)),
      false,
    )
    assert.deepEqual(terminalBenchHeldOutTasks(), TERMINAL_BENCH_HELD_OUT_TASKS)
  })
})
