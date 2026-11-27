import type { ThreadContainerRecord } from './thread-container.ts'

/** A finished run's record, as a test runner returns it. */
export function fakeRecord(threadId: string): ThreadContainerRecord {
  return {
    runtimeId: 'run-fake',
    threadId,
    startedAt: 1,
    finishedAt: 2,
    image: 'copse-worker:test',
    imageDigest: null,
    attestation: {
      runtimeId: 'run-fake',
      image: 'copse-worker:test',
      user: 1001,
      readOnlyRootfs: true,
      capDropAll: true,
      noNewPrivileges: true,
      pidsLimit: 512,
      memoryLimit: '4g',
      network: 'brokered',
      egressAllowlist: ['inference.copse.internal:443'],
      hostMounts: ['/run/copse'],
    },
    egress: [{ at: 1, origin: 'api.anthropic.com:443', event: 'connect' }],
    result: {
      threadId,
      stopReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 5 },
      harness: 'copse',
      promptsAttempted: 0,
      deferrals: [],
      denials: [],
      commits: ['abc agent: did it'],
      containment: { declared: true, declineReason: null, projectSandbox: false },
      toolNames: [],
      finalText: 'Done.',
    },
    transcript: [],
    carryIn: { sha: 'base', dirty: false },
    carryOut: { expected: true, ref: 'refs/copse/runs/run-fake', error: null },
    containerExit: 0,
    credential: 'key',
    teardown: 'removed',
    cleanupError: null,
    secretCanary: { present: false, detail: 'absent' },
  }
}
