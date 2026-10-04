/** Builders for ledger records in tests. */
import type { ResolvedConfig } from './configs.mts'
import type { TrialRecord } from './ledger.mts'

export function fixtureRecord(
  config: ResolvedConfig,
  task: string,
  rep: number,
  pass: boolean,
  overrides: Partial<TrialRecord> = {},
): TrialRecord {
  return {
    schemaVersion: 1,
    config: { id: config.id, hash: config.hash },
    tuning: config.tuning,
    task,
    rep,
    reward: pass ? 1 : 0,
    agentSeconds: 300,
    modelCalls: 40,
    inputTokens: 1000,
    outputTokens: 500,
    stopReason: 'completed',
    exception: null,
    denials: 0,
    deferrals: 0,
    promptsAttempted: 0,
    lmStudioModels: ['test-model'],
    codeRevision: 'abc123',
    startedAt: '2026-10-04T00:00:00.000Z',
    finishedAt: '2026-10-04T00:05:00.000Z',
    jobDir: '/jobs/test',
    trialDir: '/jobs/test/trial',
    valid: true,
    invalidReasons: [],
    ...overrides,
  }
}

/** Task names `t01`, `t02`, ... for synthetic ledgers. */
export function syntheticTasks(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `t${String(index + 1).padStart(2, '0')}`)
}
