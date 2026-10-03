import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { z } from 'zod'
import { terminalBenchResultsRoot } from './lib/terminal-bench.mts'
import {
  parseStepTimingLines,
  STEP_TIMING_FILE,
  summarizeStepTiming,
  stepTimingEndOffset,
  type StepTimingRecord,
} from './lib/terminal-bench-step-timing.mts'

/**
 * Where did each Terminal-Bench trial's agent time go?
 *
 *   node scripts/summarize-terminal-bench-timing.mts [job-dir] [--steps]
 *
 * With no job directory the newest job under the results root is used. A trial
 * killed at the agent timeout still has its timing file, so time spent after the
 * last recorded event (a stalled stream) is reported as `trailing`.
 */

const resultSchema = z.object({
  agent_execution: z
    .object({ started_at: z.string(), finished_at: z.string().nullable() })
    .nullable()
    .optional(),
  verifier_result: z
    .object({ rewards: z.record(z.string(), z.number()).nullable() })
    .nullable()
    .optional(),
})
const decodeResult = decodeWithSchema(resultSchema)

function latestJobDirectory(root: string): string | undefined {
  const jobs = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return jobs[0]
}

function seconds(ms: number | null): string {
  return ms === null ? '-' : (ms / 1000).toFixed(1)
}

function agentExecution(
  trialDirectory: string,
): { durationMs: number; finishedAt: string } | undefined {
  const path = join(trialDirectory, 'result.json')
  if (!existsSync(path)) return undefined
  const execution = safeJsonParse(readFileSync(path, 'utf8'), decodeResult)?.agent_execution
  if (!execution?.finished_at) return undefined
  const durationMs = Date.parse(execution.finished_at) - Date.parse(execution.started_at)
  return Number.isFinite(durationMs) && durationMs >= 0
    ? { durationMs, finishedAt: execution.finished_at }
    : undefined
}

function reward(trialDirectory: string): string {
  const path = join(trialDirectory, 'result.json')
  if (!existsSync(path)) return '-'
  const rewards = safeJsonParse(readFileSync(path, 'utf8'), decodeResult)?.verifier_result?.rewards
  const value = rewards?.['reward']
  return value === undefined ? '-' : String(value)
}

function printSteps(records: readonly StepTimingRecord[]): void {
  console.log('    step  prefill  generate  model  tool(s)  tokens(out)  chars(reason)  cut')
  const toolMsByStep = new Map<number, number>()
  for (const record of records) {
    if (record.type === 'tool_end') {
      toolMsByStep.set(record.step, (toolMsByStep.get(record.step) ?? 0) + record.durationMs)
    }
  }
  for (const record of records) {
    if (record.type !== 'stream_end') continue
    const cells = [
      String(record.step).padStart(8),
      seconds(record.prefillMs).padStart(8),
      seconds(record.generationMs).padStart(9),
      seconds(record.modelMs).padStart(6),
      seconds(toolMsByStep.get(record.step) ?? null).padStart(8),
      String(record.outputTokens ?? '-').padStart(12),
      String(record.reasoningChars).padStart(14),
      `  ${record.cutReason ?? ''}`,
    ]
    console.log(`    ${cells.join(' ')}`)
  }
}

const args = process.argv.slice(2)
const showSteps = args.includes('--steps')
const target = args.find((arg) => !arg.startsWith('--'))
const root = terminalBenchResultsRoot()
const jobDirectory = target ? resolve(target) : latestJobDirectory(root)
if (!jobDirectory || !existsSync(jobDirectory)) {
  console.error(`No job directory found under ${root}.`)
  process.exit(1)
}

console.log(`job ${basename(jobDirectory)}`)
console.log(
  'task'.padEnd(34) +
    ['reward', 'agent', 'steps', 'model', 'tools', 'overhead', 'trailing', 'maxgap']
      .map((h) => h.padStart(9))
      .join(''),
)
let found = 0
for (const entry of readdirSync(jobDirectory).sort()) {
  const trialDirectory = join(jobDirectory, entry)
  const timingPath = join(trialDirectory, 'agent', STEP_TIMING_FILE)
  if (!existsSync(timingPath)) continue
  found += 1
  const records = parseStepTimingLines(readFileSync(timingPath, 'utf8'))
  const execution = agentExecution(trialDirectory)
  const agentMs = execution?.durationMs
  const runEndMs = execution ? stepTimingEndOffset(records, execution.finishedAt) : undefined
  const summary = summarizeStepTiming(records, runEndMs)
  const open =
    summary.openStep === null ? '' : `  [step ${String(summary.openStep)} never finished]`
  console.log(
    (entry.split('__')[0] ?? entry).padEnd(34) +
      [
        reward(trialDirectory),
        seconds(agentMs ?? null),
        String(summary.steps),
        seconds(summary.modelMs),
        seconds(summary.toolMs),
        seconds(summary.overheadMs),
        seconds(summary.trailingMs),
        seconds(summary.maxChunkGapMs),
      ]
        .map((cell) => cell.padStart(9))
        .join('') +
      open,
  )
  if (showSteps) printSteps(records)
}
if (found === 0) {
  console.log(
    `(no ${STEP_TIMING_FILE} files; run the benchmark with a build that records step timing)`,
  )
}
