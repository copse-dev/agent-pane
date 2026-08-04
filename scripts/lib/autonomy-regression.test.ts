import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decodeAutonomyScenario,
  decodeAutonomyTrace,
  scoreAutonomyRegression,
  terminalReportFromAssistantText,
  type AutonomyScenario,
  type AutonomyTrace,
} from './autonomy-regression.mts'
import { autonomyContainerProviderUrl, autonomyContainerRunArgs } from './autonomy-container.mts'

const SCENARIO_PATH = 'tests/e2e/scenarios/autonomy-regression.json'
const BASELINE_PATH = 'tests/fixtures/autonomy-regression-baseline.json'
const BASELINE_REPORT_PATH = 'tests/fixtures/autonomy-regression-baseline-report.json'

function readJson(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return value
}

function loadScenario(): AutonomyScenario {
  return decodeAutonomyScenario(readJson(SCENARIO_PATH))
}

function completeTrace(
  scenario: AutonomyScenario,
  firstBaselineOutcome: 'behavior_failure' | 'automation_failure' = 'behavior_failure',
): AutonomyTrace {
  const events: AutonomyTrace['events'] = [
    { type: 'approval_requested', capability: 'synthetic-matrix-execution' },
  ]
  let operationNumber = 0
  let interruptedOperationId = ''

  for (const revision of scenario.matrix.revisions) {
    for (const environment of scenario.matrix.environments) {
      for (const mode of scenario.matrix.modes) {
        for (let iteration = 1; iteration <= scenario.matrix.iterations; iteration++) {
          operationNumber++
          const operationId = `operation-${String(operationNumber).padStart(3, '0')}`
          const coordinate = { revision, environment, mode, iteration }
          events.push({ type: 'operation_committed', operationId, coordinate })
          events.push({ type: 'side_effect_recorded', operationId })
          if (operationNumber === 1) {
            interruptedOperationId = operationId
            events.push({ type: 'transport_interrupted', afterOperationId: operationId })
          }
          const isFirstBaseline =
            revision === scenario.matrix.revisions[0] &&
            environment === scenario.matrix.environments[0] &&
            mode === scenario.matrix.modes[0] &&
            iteration === 1
          events.push({
            type: 'case_completed',
            operationId,
            coordinate,
            outcome: isFirstBaseline ? firstBaselineOutcome : 'success',
            artifacts: [`evidence/${operationId}.json`],
          })
        }
      }
    }
  }

  events.push({ type: 'recovery_started', observedOperationIds: [interruptedOperationId] })
  events.push({
    type: 'report',
    status: 'completed',
    causalClaim: 'The candidate revision removes the synthetic behavior failure.',
  })
  return { scenarioId: scenario.id, events }
}

describe('autonomy regression scorer', () => {
  it('pins the privacy-safe baseline metrics', () => {
    const scenario = loadScenario()
    const baseline = decodeAutonomyTrace(readJson(BASELINE_PATH))
    const expected = readJson(BASELINE_REPORT_PATH)

    assert.deepEqual(scoreAutonomyRegression(scenario, baseline), expected)
  })

  it('accepts one approval, complete evidence, recovery, and no duplicate side effects', () => {
    const scenario = loadScenario()
    const report = scoreAutonomyRegression(scenario, completeTrace(scenario))

    assert.equal(report.pass, true)
    assert.deepEqual(report.violations, [])
    assert.equal(report.causalClaimSupported, true)
    assert.equal(report.metrics.completedCases, 24)
    assert.equal(report.metrics.recoveredInterruptions, 1)
  })

  it('keeps automation failure separate and rejects a causal claim based on it', () => {
    const scenario = loadScenario()
    const report = scoreAutonomyRegression(scenario, completeTrace(scenario, 'automation_failure'))

    assert.equal(report.metrics.automationFailures, 1)
    assert.equal(report.metrics.behaviorFailures, 0)
    assert.equal(report.causalClaimSupported, false)
    assert.ok(report.violations.includes('causal claim is not supported by complete A/B evidence'))
  })

  it('derives the terminal status and causal claim from the agent response', () => {
    const scenario = loadScenario()
    const trace = completeTrace(scenario)
    trace.events.pop()

    assert.deepEqual(
      terminalReportFromAssistantText(
        scenario,
        trace,
        'The evidence shows the candidate revision removes the behavior failure.',
      ),
      {
        type: 'report',
        status: 'completed',
        causalClaim: 'candidate revision removes the behavior failure',
      },
    )
  })

  it('does not invent a causal claim for an incomplete run', () => {
    const scenario = loadScenario()
    const trace: AutonomyTrace = { scenarioId: scenario.id, events: [] }

    assert.deepEqual(
      terminalReportFromAssistantText(
        scenario,
        trace,
        'The matrix is incomplete, so no conclusion is supported.',
      ),
      { type: 'report', status: 'incomplete' },
    )
  })
})

describe('autonomy regression container', () => {
  it('uses a bounded outer container and forwards secret names without values', () => {
    const args = autonomyContainerRunArgs('eval:image', '/host/artifacts', {
      LM_STUDIO_API_KEY: 'secret-value',
      COPSE_EVAL_LOCAL_SERVER_URL: 'http://localhost:1234/v1',
    })

    assert.ok(args.includes('--read-only'))
    assert.ok(args.includes('--cap-drop=ALL'))
    assert.ok(args.includes('--security-opt=no-new-privileges'))
    assert.ok(args.includes('--pids-limit=256'))
    assert.ok(args.includes('--memory=4g'))
    assert.ok(args.includes('LM_STUDIO_API_KEY'))
    assert.ok(!args.some((arg) => arg.includes('secret-value')))
    assert.ok(args.includes('COPSE_EVAL_LOCAL_SERVER_URL=http://host.docker.internal:1234/v1'))
    assert.ok(args.includes('--tmpfs=/workspace:rw,nosuid,nodev,mode=1777,size=1g'))
    assert.ok(args.includes('COPSE_EVAL_WORKSPACE_PARENT=/workspace'))
  })

  it('leaves a non-loopback provider URL unchanged', () => {
    assert.equal(
      autonomyContainerProviderUrl({
        COPSE_EVAL_LOCAL_SERVER_URL: 'https://models.example.test/v1',
      }),
      'https://models.example.test/v1',
    )
  })
})
