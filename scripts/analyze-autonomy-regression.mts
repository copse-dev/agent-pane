import { readFileSync } from 'node:fs'
import {
  decodeAutonomyScenario,
  decodeAutonomyTrace,
  scoreAutonomyRegression,
} from './lib/autonomy-regression.mts'

function readJson(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return value
}

const scenarioPath = process.argv[2]
const tracePath = process.argv[3]
if (!scenarioPath || !tracePath) {
  console.error('Usage: node scripts/analyze-autonomy-regression.mts <scenario.json> <trace.json>')
  process.exit(2)
}

const scenario = decodeAutonomyScenario(readJson(scenarioPath))
const trace = decodeAutonomyTrace(readJson(tracePath))
const report = scoreAutonomyRegression(scenario, trace)

console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1
