import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  SHELL_REPLAY_LEASE_EXTERNAL_MAX_REPLAYS,
  SHELL_REPLAY_LEASE_EXTERNAL_TTL_MS,
  SHELL_REPLAY_LEASE_SANDBOX_MAX_REPLAYS,
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
  for (const containment of ['project-sandbox', 'external'] as const) {
    it(`shares an active ${containment} lease without replenishing its budget or deadline`, async () => {
      let now = 1_000
      const store = new ShellReplayLeaseStore({ now: (): number => now })
      const owner = { ...identity, containment }
      const approval = {}
      const first = store.issue(owner, 'npm test', approval)
      assert.ok(first)
      assert.equal((await store.consume(owner, 'npm test', () => false)).matched, true)
      now += 1_000

      assert.equal(store.issue(owner, 'npm test', approval), null)
      for (let index = 1; index < first.remainingReplays; index++) {
        assert.equal((await store.consume(owner, 'npm test', () => false)).matched, true)
      }
      assert.equal((await store.consume(owner, 'npm test', () => false)).matched, false)

      assert.equal(store.issue(owner, 'npm test', approval), null, 'late sibling cannot renew')
      assert.equal((await store.consume(owner, 'npm test', () => false)).matched, false)
      const renewed = store.issue(owner, 'npm test', {})
      assert.ok(renewed)
      assert.notEqual(renewed.id, first.id)
      assert.equal(renewed.remainingReplays, first.remainingReplays)
      assert.ok(renewed.expiresAt > first.expiresAt)
    })
  }

  it('can issue a fresh lease after the previous deadline', async () => {
    let now = 1_000
    const store = new ShellReplayLeaseStore({ now: (): number => now })
    const approval = {}
    const first = store.issue(identity, 'npm test', approval)
    assert.ok(first)
    now += 1_000
    assert.equal(store.issue(identity, 'npm test', approval), null)
    now = first.expiresAt
    assert.equal(store.issue(identity, 'npm test', approval), null)
    assert.equal((await store.consume(identity, 'npm test', () => false)).matched, false)
    const renewed = store.issue(identity, 'npm test', {})
    assert.ok(renewed)
    assert.notEqual(renewed.id, first.id)
    assert.equal(renewed.expiresAt, now + SHELL_REPLAY_LEASE_TTL_MS)
    assert.equal(renewed.remainingReplays, first.remainingReplays)
  })

  for (const revoke of ['lease', 'thread', 'all'] as const) {
    it(`does not resurrect an approval after revoking ${revoke}`, async () => {
      const store = new ShellReplayLeaseStore()
      const approval = {}
      const lease = store.issue(identity, 'npm test', approval)
      assert.ok(lease)
      if (revoke === 'lease') store.revoke(lease.id)
      else if (revoke === 'thread') store.revokeThread(identity.threadId)
      else store.clear()
      assert.equal(store.issue(identity, 'npm test', approval), null)
      assert.equal((await store.consume(identity, 'npm test', () => false)).matched, false)
      assert.ok(store.issue(identity, 'npm test', {}))
      assert.equal((await store.consume(identity, 'npm test', () => false)).matched, true)
    })
  }

  it('permits only the bounded number of exact replays', async () => {
    const store = new ShellReplayLeaseStore({ createId: (): string => 'lease-1' })
    store.issue(identity, 'npm test -- permission-gate', {})

    for (let index = 0; index < SHELL_REPLAY_LEASE_SANDBOX_MAX_REPLAYS; index++) {
      assert.deepEqual(await store.consume(identity, 'npm test -- permission-gate', () => false), {
        matched: true,
        leaseId: 'lease-1',
        companionSegments: [],
      })
    }
    assert.deepEqual(await store.consume(identity, 'npm test -- permission-gate', () => false), {
      matched: false,
    })
  })

  it('gives an outside-sandbox lease its own replay bound and a longer window', async () => {
    let now = 1_000
    const store = new ShellReplayLeaseStore({ now: (): number => now })
    const external: ShellReplayLeaseIdentity = { ...identity, containment: 'external' }
    const lease = store.issue(external, 'npm test', {})
    assert.ok(lease)

    assert.equal(lease.remainingReplays, SHELL_REPLAY_LEASE_EXTERNAL_MAX_REPLAYS)
    assert.equal(lease.expiresAt, 1_000 + SHELL_REPLAY_LEASE_EXTERNAL_TTL_MS)
    assert.ok(SHELL_REPLAY_LEASE_EXTERNAL_TTL_MS > SHELL_REPLAY_LEASE_TTL_MS)
    // Past the sandbox window, still inside its own.
    now += SHELL_REPLAY_LEASE_TTL_MS + 60_000
    assert.equal((await store.consume(external, 'npm test', () => true)).matched, true)
    now = 1_000 + SHELL_REPLAY_LEASE_EXTERNAL_TTL_MS
    assert.deepEqual(await store.consume(external, 'npm test', () => true), { matched: false })
  })

  it('binds a lease to project, thread, turn tree, and execution root', async () => {
    const changedIdentities: ShellReplayLeaseIdentity[] = [
      { ...identity, projectId: 'project-2' },
      { ...identity, threadId: 'thread-2' },
      { ...identity, turnTreeId: asTurnTreeId('tree-2') },
      { ...identity, executionRoot: '/workspace/other' },
      { ...identity, containment: 'external' },
    ]

    for (const changed of changedIdentities) {
      const store = new ShellReplayLeaseStore()
      store.issue(identity, 'npm test', {})
      assert.deepEqual(await store.consume(changed, 'npm test', () => true), { matched: false })
    }
  })

  it('expires fail closed and supports explicit revocation', async () => {
    let now = 1_000
    const store = new ShellReplayLeaseStore({
      now: (): number => now,
      createId: (): string => 'lease-1',
    })
    store.issue(identity, 'npm test', {})
    now += SHELL_REPLAY_LEASE_TTL_MS
    assert.deepEqual(await store.consume(identity, 'npm test', () => true), { matched: false })

    now = 1_000
    const lease = store.issue(identity, 'npm test', {})
    assert.ok(lease)
    assert.equal(store.revoke(lease.id), true)
    assert.deepEqual(await store.consume(identity, 'npm test', () => true), { matched: false })
  })

  it('issues a script-argument lease once per approval', () => {
    const store = new ShellReplayLeaseStore()
    const external: ShellReplayLeaseIdentity = { ...identity, containment: 'external' }
    const approval = {}
    const lease = store.issue(external, 'node audit.mjs first', approval, 'script-scope')
    assert.ok(lease)
    assert.equal(lease.scriptScope, 'script-scope')
    assert.equal(store.issue(external, 'node audit.mjs first', approval, 'script-scope'), null)
    assert.equal(store.issue(external, 'node audit.mjs first', approval), null)
    assert.ok(store.issue(external, 'node audit.mjs first', {}, 'script-scope'))
  })

  it('forgets grants on restart and refuses denied or absent authority', async () => {
    const store = new ShellReplayLeaseStore()
    assert.equal((await store.consume(identity, 'npm test', () => true)).matched, false)
    store.issue(identity, 'npm test', {})
    const restarted = new ShellReplayLeaseStore()
    assert.equal((await restarted.consume(identity, 'npm test', () => true)).matched, false)
    store.clear()
    assert.equal((await store.consume(identity, 'npm test', () => true)).matched, false)
  })

  it('allows independently authorized output filters after the exact leased command', async () => {
    const store = new ShellReplayLeaseStore({ createId: (): string => 'lease-1' })
    store.issue(identity, 'npm test -- permission-gate', {})
    const seen: string[] = []

    assert.deepEqual(
      await store.consume(
        identity,
        'npm test -- permission-gate | rg failed | head -20',
        (segment) => {
          seen.push(segment)
          return segment === 'rg failed' || segment === 'head -20'
        },
      ),
      {
        matched: true,
        leaseId: 'lease-1',
        companionSegments: ['rg failed', 'head -20'],
      },
    )
    assert.deepEqual(seen, ['rg failed', 'head -20'])
  })

  it('composes an exact lease with independently authorized commands', async () => {
    const store = new ShellReplayLeaseStore({ createId: (): string => 'lease-1' })
    store.issue(identity, 'npm test -- permission-gate', {})
    const allowed = new Set(['cd /workspace/project', 'ls artifacts', 'rg failed'])

    assert.deepEqual(
      await store.consume(
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

  it('rejects altered, piped input, unsupported control flow, and unauthorized companions', async () => {
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
      store.issue(identity, 'npm test -- permission-gate', {})
      assert.deepEqual(
        await store.consume(identity, command, (segment) => segment.startsWith('rg')),
        { matched: false },
        command,
      )
    }
  })
})
