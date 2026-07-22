import {
  TERMINAL_BENCH_ABLATION_PROFILES,
  TERMINAL_BENCH_HELD_OUT_SEED,
  TERMINAL_BENCH_HELD_OUT_TASKS,
  TERMINAL_BENCH_HISTORICAL_TASKS,
} from './lib/terminal-bench-ablation.mts'

const phaseArgument = process.argv.find((argument) => argument.startsWith('--phase='))
const phase = phaseArgument?.slice('--phase='.length) ?? 'diagnostic'
if (phase !== 'diagnostic' && phase !== 'held-out') {
  throw new Error('Ablation phase must be diagnostic or held-out.')
}
const tasks =
  phase === 'diagnostic' ? [...TERMINAL_BENCH_HISTORICAL_TASKS] : TERMINAL_BENCH_HELD_OUT_TASKS
const attempts = phase === 'diagnostic' ? 1 : 5
const plan = {
  schemaVersion: 1,
  dataset: 'terminal-bench/terminal-bench-2-1',
  phase,
  model: 'qwen3.6-35b-a3b',
  profiles: TERMINAL_BENCH_ABLATION_PROFILES,
  tasks,
  attempts,
  taskNamesInput: tasks.join(','),
  heldOutSeed: TERMINAL_BENCH_HELD_OUT_SEED,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(plan, null, 2))
} else {
  console.log(`Terminal-Bench 2.1 ${phase} ablation`)
  console.log(`model: ${plan.model}`)
  console.log(`attempts: ${String(attempts)}`)
  console.log(`profiles: ${plan.profiles.join(', ')}`)
  console.log(`task_names: ${plan.taskNamesInput}`)
}
