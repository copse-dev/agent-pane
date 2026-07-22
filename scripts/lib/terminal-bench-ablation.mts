import { createHash } from 'node:crypto'
import { TERMINAL_BENCH_TASK_NAMES } from './terminal-bench-tasks.mts'

export const TERMINAL_BENCH_ABLATION_PROFILES = [
  'main-legacy',
  'pr-1149',
  'product-aligned',
] as const

export const TERMINAL_BENCH_HISTORICAL_TASKS = [
  'cancel-async-tasks',
  'circuit-fibsqrt',
  'break-filter-js-from-html',
  'chess-best-move',
] as const

export const TERMINAL_BENCH_HELD_OUT_SEED = 'copse-tbench-2.1-ablation-v1:'

function cohortOrder(taskName: string): string {
  return createHash('sha256').update(`${TERMINAL_BENCH_HELD_OUT_SEED}${taskName}`).digest('hex')
}

export function terminalBenchHeldOutTasks(count = 12): string[] {
  if (!Number.isInteger(count) || count <= 0)
    throw new Error('Held-out task count must be positive.')
  const historical = new Set<string>(TERMINAL_BENCH_HISTORICAL_TASKS)
  const eligible = TERMINAL_BENCH_TASK_NAMES.filter((taskName) => !historical.has(taskName))
  if (count > eligible.length) throw new Error('Held-out task count exceeds the eligible task set.')
  return [...eligible]
    .sort((a, b) => cohortOrder(a).localeCompare(cohortOrder(b)) || a.localeCompare(b))
    .slice(0, count)
}

export const TERMINAL_BENCH_HELD_OUT_TASKS = terminalBenchHeldOutTasks()
