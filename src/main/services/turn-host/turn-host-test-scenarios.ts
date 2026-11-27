import {
  clearMockScenarios,
  mockScenarioStatus,
  parseMockScenario,
  releaseMockScenario,
  setMockScenario,
} from '@copse/llm/mock-script.ts'
import type {
  TestScenarioOp,
  TestScenarioResult,
  TestScenarioStatus,
} from './turn-host-protocol.ts'

/**
 * Scripted model scenarios for host turns, in e2e builds only
 * (`docs/plans/local-turn-worker.md`, "Every turn in a turn host", H5).
 *
 * A turn claims its scripted responses from the scenario store of the process
 * it runs in, and a host turn runs in the host. So the app's test controls set,
 * release and clear each scenario in both processes, and read its status from
 * whichever has run it further: a scenario the host ran is still there after
 * the app was killed and launched again.
 */

/** The host's end: apply one operation to this process's scenario store. */
export function runTestScenarioOp(op: TestScenarioOp): TestScenarioStatus | undefined {
  switch (op.kind) {
    case 'set':
      setMockScenario(op.scenarioId, parseMockScenario(op.scenario), op.scope)
      return mockScenarioStatus(op.scenarioId)
    case 'release':
      releaseMockScenario(op.scenarioId, op.hold)
      return undefined
    case 'clear':
      clearMockScenarios()
      return undefined
    case 'status':
      return mockScenarioStatus(op.scenarioId)
  }
}

type Forward = (op: TestScenarioOp) => Promise<TestScenarioResult | null>

let forward: Forward | null = null

/** The app's link to its host, set while turns run in a host. */
export function setTestScenarioForwarder(next: Forward | null): void {
  forward = next
}

/** Send an operation to the host. Null when no host takes turns for this app. */
export function forwardTestScenarioOp(op: TestScenarioOp): Promise<TestScenarioResult | null> {
  return forward ? forward(op) : Promise.resolve(null)
}

/**
 * Run an operation here and in the host. It fails only when it failed in every
 * process that was asked, so a release or status after a relaunch, which this
 * app never saw set, still reaches the host's copy.
 */
export async function runTestScenarioEverywhere(
  op: TestScenarioOp,
): Promise<TestScenarioStatus | undefined> {
  let local: { status: TestScenarioStatus | undefined } | { error: string }
  try {
    local = { status: runTestScenarioOp(op) }
  } catch (error) {
    local = { error: error instanceof Error ? error.message : String(error) }
  }
  const host = await forwardTestScenarioOp(op)
  // A scenario set in one process must be set in both, or a turn could claim
  // from a copy the test never sees.
  if (op.kind === 'set' && host?.error !== undefined) throw new Error(host.error)
  if ('error' in local) {
    if (host === null || host.error !== undefined) throw new Error(local.error)
    return host.status
  }
  if (host?.status === undefined || host.error !== undefined) return local.status
  return local.status === undefined ? host.status : furthest(local.status, host.status)
}

/** The copy that has run further; a turn runs in one process only. */
function furthest(a: TestScenarioStatus, b: TestScenarioStatus): TestScenarioStatus {
  // A copy waiting on a hold has claimed its response; the other never ran it.
  const progress = (s: TestScenarioStatus): number =>
    s.errors.length > 0
      ? Number.MAX_SAFE_INTEGER
      : (s.turn * 1_000 + s.response + s.cancelledTurns) * 2 + (s.waitingFor === null ? 0 : 1)
  return progress(b) > progress(a) ? b : a
}
