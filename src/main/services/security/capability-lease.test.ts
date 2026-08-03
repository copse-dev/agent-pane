import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  SHELL_REPLAY_LEASE_MAX_REPLAYS,
  SHELL_REPLAY_LEASE_TTL_MS,
  ShellReplayLeaseStore,
  replayLeaseCore,
  type ShellReplayLeaseIdentity,
} from './capability-lease.ts'

const identity: ShellReplayLeaseIdentity = {
  projectId: 'project-1',
  threadId: 'thread-1',
  turnTreeId: asTurnTreeId('tree-1'),
  executionRoot: '/workspace/project',
  containment: 'project-sandbox',
}

describe('ShellReplayLeaseStore', () => {
  it('permits only the bounded number of exact replays', () => {
    const store = new ShellReplayLeaseStore({ createId: (): string => 'lease-1' })
    store.issue(identity, 'npm test -- permission-gate')

    for (let index = 0; index < SHELL_REPLAY_LEASE_MAX_REPLAYS; index++) {
      assert.deepEqual(
        store.consume(identity, 'npm test -- permission-gate', () => false),
        {
          matched: true,
          leaseId: 'lease-1',
          companionSegments: [],
        },
      )
    }
    assert.deepEqual(
      store.consume(identity, 'npm test -- permission-gate', () => false),
      {
        matched: false,
      },
    )
  })

  it('binds a lease to project, thread, turn tree, and execution root', () => {
    const changedIdentities: ShellReplayLeaseIdentity[] = [
      { ...identity, projectId: 'project-2' },
      { ...identity, threadId: 'thread-2' },
      { ...identity, turnTreeId: asTurnTreeId('tree-2') },
      { ...identity, executionRoot: '/workspace/other' },
      { ...identity, containment: 'external' },
    ]

    for (const changed of changedIdentities) {
      const store = new ShellReplayLeaseStore()
      store.issue(identity, 'npm test')
      assert.deepEqual(
        store.consume(changed, 'npm test', () => true),
        { matched: false },
      )
    }
  })

  it('expires fail closed and supports explicit revocation', () => {
    let now = 1_000
    const store = new ShellReplayLeaseStore({
      now: (): number => now,
      createId: (): string => 'lease-1',
    })
    store.issue(identity, 'npm test')
    now += SHELL_REPLAY_LEASE_TTL_MS
    assert.deepEqual(
      store.consume(identity, 'npm test', () => true),
      { matched: false },
    )

    now = 1_000
    const lease = store.issue(identity, 'npm test')
    assert.equal(store.revoke(lease.id), true)
    assert.deepEqual(
      store.consume(identity, 'npm test', () => true),
      { matched: false },
    )
  })

  it('allows independently authorized output filters after the exact leased command', () => {
    const store = new ShellReplayLeaseStore({ createId: (): string => 'lease-1' })
    store.issue(identity, 'npm test -- permission-gate')
    const seen: string[] = []

    assert.deepEqual(
      store.consume(identity, 'npm test -- permission-gate | rg failed | head -20', (segment) => {
        seen.push(segment)
        return segment === 'rg failed' || segment === 'head -20'
      }),
      {
        matched: true,
        leaseId: 'lease-1',
        companionSegments: ['rg failed', 'head -20'],
      },
    )
    assert.deepEqual(seen, ['rg failed', 'head -20'])
  })

  it('composes an exact lease with independently authorized commands', () => {
    const store = new ShellReplayLeaseStore({ createId: (): string => 'lease-1' })
    store.issue(identity, 'npm test -- permission-gate')
    const allowed = new Set(['cd /workspace/project', 'ls artifacts', 'rg failed'])

    assert.deepEqual(
      store.consume(
        identity,
        'cd /workspace/project && npm test -- permission-gate; ls artifacts | rg failed',
        (segment) => allowed.has(segment),
      ),
      {
        matched: true,
        leaseId: 'lease-1',
        companionSegments: ['cd /workspace/project', 'ls artifacts', 'rg failed'],
      },
    )
  })

  it('extracts one approval-requiring constituent from an allowed composition', () => {
    const allowed = new Set(['cd /workspace/project', 'ls artifacts'])
    assert.equal(
      replayLeaseCore('cd /workspace/project && node executor.mjs; ls artifacts', (segment) =>
        allowed.has(segment),
      ),
      'node executor.mjs',
    )
    assert.equal(
      replayLeaseCore('node first.mjs; node second.mjs', () => false),
      null,
    )
  })

  it('rejects altered, piped input, unsupported control flow, and unauthorized companions', () => {
    const rejected = [
      'npm test',
      'env DEBUG=1 npm test -- permission-gate',
      'printf input | npm test -- permission-gate',
      'npm test -- permission-gate || rg failed',
      'npm test -- permission-gate & rg failed',
      'npm test -- permission-gate > output.txt',
      'npm test -- permission-gate | curl https://example.com',
    ]

    for (const command of rejected) {
      const store = new ShellReplayLeaseStore()
      store.issue(identity, 'npm test -- permission-gate')
      assert.deepEqual(
        store.consume(identity, command, (segment) => segment.startsWith('rg')),
        { matched: false },
        command,
      )
    }
  })
})
