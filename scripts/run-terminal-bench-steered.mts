import { spawnSync } from 'node:child_process'
import { glob, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadTerminalBenchSteering } from './lib/terminal-bench-steering.mts'
import { recordTerminalBenchTaskImage } from './lib/terminal-bench-task-image.mts'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'
import { terminalBenchCanonicalTaskName } from './lib/terminal-bench-tasks.mts'
import { terminalBenchAnalysisPlanPath, terminalBenchResultsRoot } from './lib/terminal-bench.mts'

const PLAN_PATH = terminalBenchAnalysisPlanPath()
const rawArgs = process.argv.slice(2)
const profileArgs = rawArgs.filter((arg) => arg.startsWith('--profile='))
if (profileArgs.length > 1 || rawArgs.some((arg) => !arg.startsWith('--profile='))) {
  throw new Error('Usage: npm run bench:terminal:steered -- [--profile=<id>]')
}
const profile = terminalBenchProfile(profileArgs[0]?.slice('--profile='.length))

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() ? field : undefined
}

async function resultPaths(): Promise<Set<string>> {
  const paths = new Set<string>()
  for await (const path of glob(resolve(terminalBenchResultsRoot(), '*/*/result.json'))) {
    paths.add(path)
  }
  return paths
}

async function resultTaskName(path: string): Promise<string | undefined> {
  const result: unknown = JSON.parse(await readFile(path, 'utf8'))
  const taskName = stringField(result, 'task_name')
  return taskName ? terminalBenchCanonicalTaskName(taskName) : undefined
}

const parsed: unknown = JSON.parse(await readFile(PLAN_PATH, 'utf8'))
const entries =
  typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)['entries']
    : undefined
if (!Array.isArray(entries)) throw new Error(`${PLAN_PATH} does not contain an entries array.`)

for (const entry of entries) {
  const taskName = stringField(entry, 'taskName')
  const parentTrialId = stringField(entry, 'parentTrialId')
  const interventionId = stringField(entry, 'interventionId')
  const steeringPath = stringField(entry, 'steeringPath')
  if (!taskName || !parentTrialId || !interventionId || !steeringPath) {
    throw new Error(`${PLAN_PATH} contains an invalid rerun entry.`)
  }
  const { steering, interventionId: calculatedInterventionId } =
    loadTerminalBenchSteering(steeringPath)
  if (steering.parent_trial_id !== parentTrialId) {
    throw new Error(`Steering parent does not match the rerun plan for ${taskName}.`)
  }
  if (calculatedInterventionId !== interventionId) {
    throw new Error(`Steering digest does not match the rerun plan for ${taskName}.`)
  }
  console.log(
    `bench:terminal:steered rerunning ${taskName} parent=${parentTrialId} intervention=${interventionId}`,
  )
  const beforePaths = await resultPaths()
  const run = spawnSync(
    process.execPath,
    [
      resolve('scripts/run-terminal-bench.mts'),
      '--include-task-name',
      taskName,
      '-k',
      '1',
      `--profile=${profile.versionedId}`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COPSE_TERMINAL_STEERING_FILE: steeringPath,
        COPSE_TERMINAL_PARENT_TRIAL_ID: parentTrialId,
        COPSE_TERMINAL_INTERVENTION_ID: interventionId,
        COPSE_TERMINAL_PROFILE: profile.id,
        COPSE_TERMINAL_PROFILE_VERSIONED_ID: profile.versionedId,
        COPSE_TERMINAL_PROFILE_HASH: profile.contentHash,
        ...(steering.recommended_step_budget !== undefined
          ? { COPSE_TERMINAL_MAX_STEPS: String(steering.recommended_step_budget) }
          : {}),
      },
      stdio: 'inherit',
    },
  )
  if (run.error || run.status !== 0) {
    const detail = run.error?.message ?? `child exited ${String(run.status)}`
    throw new Error(`Steered rerun for ${taskName} failed: ${detail}`)
  }
  const afterPaths = await resultPaths()
  const newPaths = [...afterPaths].filter((path) => !beforePaths.has(path))
  const matchingPaths: string[] = []
  for (const path of newPaths) {
    if ((await resultTaskName(path)) === taskName) matchingPaths.push(path)
  }
  if (matchingPaths.length === 0) {
    throw new Error(`Steered rerun for ${taskName} did not write a new result.`)
  }
  for (const path of matchingPaths) await recordTerminalBenchTaskImage(taskName, path)
}

console.log(`bench:terminal:steered completed ${String(entries.length)} rerun(s)`)
