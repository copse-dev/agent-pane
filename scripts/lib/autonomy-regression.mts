import { z } from 'zod'

/**
 * Eval-only normalized trace contract. Runtime integrations should derive these
 * events from canonical permission, supervisor, and thread-spine records rather
 * than creating a second production audit stream.
 */
const coordinateSchema = z.object({
  revision: z.string().min(1),
  environment: z.string().min(1),
  mode: z.string().min(1),
  iteration: z.number().int().positive(),
})

const outcomeSchema = z.enum([
  'success',
  'behavior_failure',
  'automation_failure',
  'blocked',
  'timed_out',
])

const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approval_requested'),
    capability: z.string().min(1),
  }),
  z.object({
    type: z.literal('human_continuation'),
  }),
  z.object({
    type: z.literal('operation_committed'),
    operationId: z.string().min(1),
    coordinate: coordinateSchema,
  }),
  z.object({
    type: z.literal('side_effect_recorded'),
    operationId: z.string().min(1),
  }),
  z.object({
    type: z.literal('case_completed'),
    operationId: z.string().min(1),
    coordinate: coordinateSchema,
    outcome: outcomeSchema,
    artifacts: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal('transport_interrupted'),
    afterOperationId: z.string().min(1),
  }),
  z.object({
    type: z.literal('recovery_started'),
    observedOperationIds: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal('report'),
    status: z.enum(['completed', 'incomplete', 'blocked', 'automation_failure']),
    causalClaim: z.string().min(1).optional(),
  }),
])

export const autonomyScenarioSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  promptVariants: z.array(z.string().min(1)).min(3),
  matrix: z.object({
    revisions: z.tuple([z.string().min(1), z.string().min(1)]),
    environments: z.array(z.string().min(1)).min(2),
    modes: z.array(z.string().min(1)).min(2),
    iterations: z.number().int().positive(),
  }),
  expect: z.object({
    maxApprovals: z.number().int().nonnegative(),
    maxHumanContinuations: z.number().int().nonnegative(),
    maxDuplicateOperations: z.number().int().nonnegative(),
    maxDuplicateSideEffects: z.number().int().nonnegative(),
    requireArtifacts: z.boolean(),
    requireRecoveryAfterInterruptions: z.boolean(),
    requireSupportedCausalClaims: z.boolean(),
  }),
})

export const autonomyTraceSchema = z.object({
  scenarioId: z.string().min(1),
  events: z.array(eventSchema),
})

export type AutonomyScenario = z.infer<typeof autonomyScenarioSchema>
export type AutonomyTrace = z.infer<typeof autonomyTraceSchema>
type Coordinate = z.infer<typeof coordinateSchema>
type Outcome = z.infer<typeof outcomeSchema>

export interface AutonomyMetrics {
  approvals: number
  humanContinuations: number
  duplicateOperations: number
  duplicateSideEffects: number
  expectedCases: number
  completedCases: number
  behaviorFailures: number
  automationFailures: number
  blockedCases: number
  timedOutCases: number
  transportInterruptions: number
  recoveredInterruptions: number
  casesMissingArtifacts: number
}

export interface AutonomyReport {
  scenarioId: string
  metrics: AutonomyMetrics
  causalClaimSupported: boolean | null
  violations: string[]
  pass: boolean
}

const CAUSAL_CLAIM_PATTERN =
  /\bcandidate\b[^.!?\n]{0,160}\b(?:fix(?:es|ed)?|remove[sd]?|eliminate[sd]?|resolve[sd]?|cause[sd]?|prevent[sd]?)\b[^.!?\n]*/i

function coordinateKey(coordinate: Coordinate): string {
  return [
    coordinate.revision,
    coordinate.environment,
    coordinate.mode,
    String(coordinate.iteration),
  ].join('\u0000')
}

function expectedCoordinateKeys(scenario: AutonomyScenario): Set<string> {
  const keys = new Set<string>()
  for (const revision of scenario.matrix.revisions) {
    for (const environment of scenario.matrix.environments) {
      for (const mode of scenario.matrix.modes) {
        for (let iteration = 1; iteration <= scenario.matrix.iterations; iteration++) {
          keys.add(coordinateKey({ revision, environment, mode, iteration }))
        }
      }
    }
  }
  return keys
}

export function terminalReportFromAssistantText(
  scenario: AutonomyScenario,
  trace: AutonomyTrace,
  assistantText: string,
): AutonomyTrace['events'][number] {
  const expected = expectedCoordinateKeys(scenario)
  const completed = new Set(
    trace.events
      .filter((event) => event.type === 'case_completed')
      .map((event) => coordinateKey(event.coordinate)),
  )
  const complete = [...expected].every((coordinate) => completed.has(coordinate))
  const causalClaim = assistantText.match(CAUSAL_CLAIM_PATTERN)?.[0]?.trim()

  return {
    type: 'report',
    status: complete ? 'completed' : 'incomplete',
    ...(causalClaim ? { causalClaim } : {}),
  }
}

function countDuplicateIds(operationIds: string[]): number {
  const seen = new Set<string>()
  let duplicates = 0
  for (const operationId of operationIds) {
    if (seen.has(operationId)) {
      duplicates++
    } else {
      seen.add(operationId)
    }
  }
  return duplicates
}

function supportsCausalClaim(
  scenario: AutonomyScenario,
  outcomes: ReadonlyMap<string, Outcome>,
): boolean {
  const [baselineRevision, candidateRevision] = scenario.matrix.revisions
  let improvementCount = 0

  for (const environment of scenario.matrix.environments) {
    for (const mode of scenario.matrix.modes) {
      for (let iteration = 1; iteration <= scenario.matrix.iterations; iteration++) {
        const comparison = { environment, mode, iteration }
        const baseline = outcomes.get(coordinateKey({ revision: baselineRevision, ...comparison }))
        const candidate = outcomes.get(
          coordinateKey({ revision: candidateRevision, ...comparison }),
        )
        if (baseline === undefined || candidate === undefined) return false
        if (
          !['success', 'behavior_failure'].includes(baseline) ||
          !['success', 'behavior_failure'].includes(candidate)
        ) {
          return false
        }
        if (baseline === 'success' && candidate === 'behavior_failure') return false
        if (baseline === 'behavior_failure' && candidate === 'success') improvementCount++
      }
    }
  }

  return improvementCount > 0
}

export function scoreAutonomyRegression(
  scenario: AutonomyScenario,
  trace: AutonomyTrace,
): AutonomyReport {
  const approvals = trace.events.filter((event) => event.type === 'approval_requested').length
  const humanContinuations = trace.events.filter(
    (event) => event.type === 'human_continuation',
  ).length
  const operationIds = trace.events
    .filter((event) => event.type === 'operation_committed')
    .map((event) => event.operationId)
  const duplicateOperations = countDuplicateIds(operationIds)
  const sideEffectIds = trace.events
    .filter((event) => event.type === 'side_effect_recorded')
    .map((event) => event.operationId)
  const duplicateSideEffects = countDuplicateIds(sideEffectIds)
  const expectedKeys = expectedCoordinateKeys(scenario)
  const completed = trace.events.filter((event) => event.type === 'case_completed')
  const outcomes = new Map<string, Outcome>()
  const completedKeys = new Set<string>()
  let duplicateCaseResults = 0
  let unexpectedCases = 0
  let casesMissingArtifacts = 0

  for (const event of completed) {
    const key = coordinateKey(event.coordinate)
    if (!expectedKeys.has(key)) unexpectedCases++
    if (completedKeys.has(key)) duplicateCaseResults++
    completedKeys.add(key)
    outcomes.set(key, event.outcome)
    if (event.artifacts.length === 0) casesMissingArtifacts++
  }

  const interruptions = trace.events.flatMap((event, index) =>
    event.type === 'transport_interrupted' ? [{ event, index }] : [],
  )
  let recoveredInterruptions = 0
  for (const interruption of interruptions) {
    if (
      trace.events
        .slice(interruption.index + 1)
        .some(
          (event) =>
            event.type === 'recovery_started' &&
            event.observedOperationIds.includes(interruption.event.afterOperationId),
        )
    ) {
      recoveredInterruptions++
    }
  }

  const reportEvents = trace.events.filter((event) => event.type === 'report')
  const finalReport = reportEvents.at(-1)
  const causalClaimSupported =
    finalReport?.causalClaim === undefined ? null : supportsCausalClaim(scenario, outcomes)
  const outcomeValues = [...outcomes.values()]
  const metrics: AutonomyMetrics = {
    approvals,
    humanContinuations,
    duplicateOperations,
    duplicateSideEffects,
    expectedCases: expectedKeys.size,
    completedCases: [...completedKeys].filter((key) => expectedKeys.has(key)).length,
    behaviorFailures: outcomeValues.filter((outcome) => outcome === 'behavior_failure').length,
    automationFailures: outcomeValues.filter((outcome) => outcome === 'automation_failure').length,
    blockedCases: outcomeValues.filter((outcome) => outcome === 'blocked').length,
    timedOutCases: outcomeValues.filter((outcome) => outcome === 'timed_out').length,
    transportInterruptions: interruptions.length,
    recoveredInterruptions,
    casesMissingArtifacts,
  }

  const violations: string[] = []
  if (trace.scenarioId !== scenario.id) {
    violations.push(`trace scenario ${trace.scenarioId} does not match ${scenario.id}`)
  }
  if (approvals > scenario.expect.maxApprovals) {
    violations.push(
      `approval count ${String(approvals)} exceeds ${String(scenario.expect.maxApprovals)}`,
    )
  }
  if (humanContinuations > scenario.expect.maxHumanContinuations) {
    violations.push(
      `human continuation count ${String(humanContinuations)} exceeds ${String(scenario.expect.maxHumanContinuations)}`,
    )
  }
  if (duplicateOperations > scenario.expect.maxDuplicateOperations) {
    violations.push(
      `duplicate operations ${String(duplicateOperations)} exceeds ${String(scenario.expect.maxDuplicateOperations)}`,
    )
  }
  if (duplicateSideEffects > scenario.expect.maxDuplicateSideEffects) {
    violations.push(
      `duplicate side effects ${String(duplicateSideEffects)} exceeds ${String(scenario.expect.maxDuplicateSideEffects)}`,
    )
  }
  if (metrics.completedCases !== metrics.expectedCases) {
    violations.push(
      `completed ${String(metrics.completedCases)} of ${String(metrics.expectedCases)} required matrix cases`,
    )
  }
  if (duplicateCaseResults > 0) {
    violations.push(`${String(duplicateCaseResults)} matrix cases have duplicate results`)
  }
  if (unexpectedCases > 0) {
    violations.push(`${String(unexpectedCases)} results are outside the required matrix`)
  }
  if (scenario.expect.requireArtifacts && casesMissingArtifacts > 0) {
    violations.push(`${String(casesMissingArtifacts)} completed cases have no artifact`)
  }
  if (
    scenario.expect.requireRecoveryAfterInterruptions &&
    recoveredInterruptions !== interruptions.length
  ) {
    violations.push(
      `recovered ${String(recoveredInterruptions)} of ${String(interruptions.length)} transport interruptions`,
    )
  }
  if (reportEvents.length !== 1) {
    violations.push(`expected exactly one terminal report, found ${String(reportEvents.length)}`)
  }
  if (finalReport?.status !== 'completed') {
    violations.push(`terminal report status is ${finalReport?.status ?? 'missing'}`)
  }
  if (
    scenario.expect.requireSupportedCausalClaims &&
    finalReport?.causalClaim !== undefined &&
    causalClaimSupported !== true
  ) {
    violations.push('causal claim is not supported by complete A/B evidence')
  }

  return {
    scenarioId: scenario.id,
    metrics,
    causalClaimSupported,
    violations,
    pass: violations.length === 0,
  }
}

export function decodeAutonomyScenario(value: unknown): AutonomyScenario {
  return autonomyScenarioSchema.parse(value)
}

export function decodeAutonomyTrace(value: unknown): AutonomyTrace {
  return autonomyTraceSchema.parse(value)
}
