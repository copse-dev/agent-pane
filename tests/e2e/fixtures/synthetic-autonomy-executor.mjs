import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const scenarioId = 'synthetic-ab-autonomy'
const revisions = ['baseline', 'candidate']
const environments = ['alpha', 'beta']
const modes = ['direct', 'staged']
const iterations = 3
const outputDir = join(process.cwd(), '.autonomy')
const evidenceDir = join(outputDir, 'evidence')
const statePath = join(outputDir, 'state.json')
const tracePath = join(outputDir, 'trace.json')
const backgroundWakeMode = existsSync(join(outputDir, 'background-wake-mode'))

mkdirSync(evidenceDir, { recursive: true })

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}

async function delayForBackgroundWake() {
  if (!backgroundWakeMode) return
  await new Promise((resolve) => setTimeout(resolve, 1_500))
}

const coordinates = []
for (const revision of revisions) {
  for (const environment of environments) {
    for (const mode of modes) {
      for (let iteration = 1; iteration <= iterations; iteration++) {
        coordinates.push({ revision, environment, mode, iteration })
      }
    }
  }
}

const state = readJson(statePath, { nextIndex: 0, interrupted: false, completed: false })
const trace = readJson(tracePath, { scenarioId, events: [] })

if (state.completed) {
  process.stdout.write(`${tracePath}\n`)
  process.exit(0)
}

if (state.interrupted) {
  trace.events.push({
    type: 'recovery_started',
    observedOperationIds: ['operation-001'],
  })
  state.interrupted = false
}

for (let index = state.nextIndex; index < coordinates.length; index++) {
  const coordinate = coordinates[index]
  const operationId = `operation-${String(index + 1).padStart(3, '0')}`
  const firstBaselineCase =
    coordinate.revision === 'baseline' &&
    coordinate.environment === 'alpha' &&
    coordinate.mode === 'direct' &&
    coordinate.iteration === 1
  const outcome = firstBaselineCase ? 'behavior_failure' : 'success'
  const artifact = `.autonomy/evidence/${operationId}.json`

  trace.events.push({ type: 'operation_committed', operationId, coordinate })
  trace.events.push({ type: 'side_effect_recorded', operationId })
  writeJson(join(process.cwd(), artifact), { operationId, coordinate, outcome })
  trace.events.push({
    type: 'case_completed',
    operationId,
    coordinate,
    outcome,
    artifacts: [artifact],
  })
  state.nextIndex = index + 1
  writeJson(tracePath, trace)
  writeJson(statePath, state)

  if (index === 0) {
    trace.events.push({ type: 'transport_interrupted', afterOperationId: operationId })
    state.interrupted = true
    writeJson(tracePath, trace)
    writeJson(statePath, state)
    process.stderr.write(
      'Synthetic transient interruption after a committed result. Run this command again to resume.\n',
    )
    await delayForBackgroundWake()
    process.exit(75)
  }
}

state.completed = true
writeJson(tracePath, trace)
writeJson(statePath, state)
await delayForBackgroundWake()
process.stdout.write(`${tracePath}\n`)
