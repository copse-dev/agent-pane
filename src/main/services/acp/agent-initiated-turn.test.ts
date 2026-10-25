import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import {
  createAgentInitiatedTurnLease,
  type AgentInitiatedTurnAuthority,
  type AgentInitiatedTurnClaim,
  type AgentInitiatedTurnLease,
  type AgentInitiatedTurnLeaseDeps,
} from './agent-initiated-turn.ts'

const CONTEXT: ThreadExecutionContext = {
  projectId: 'project',
  threadId: 'thread',
  projectRoot: '/project/checkout',
  root: '/worktrees/thread',
  checkoutMode: 'worktree',
  branch: 'copse/thread',
}

interface Harness {
  lease: AgentInitiatedTurnLease
  events: string[]
  claimCalls: boolean[]
  pending: () => Promise<ThreadExecutionContext | null> | null
}

function setup(options: {
  claims: AgentInitiatedTurnClaim[]
  confirm?: boolean
  authority?: boolean
}): Harness {
  const events: string[] = []
  const claimCalls: boolean[] = []
  const queue = [...options.claims]
  const authority: AgentInitiatedTurnAuthority = {
    claimAgentInitiatedTurn: (_project, _thread, { override }) => {
      claimCalls.push(override)
      return Promise.resolve(queue.shift() ?? { status: 'budget-exhausted' })
    },
  }
  let pending: Promise<ThreadExecutionContext | null> | null = null
  const deps: AgentInitiatedTurnLeaseDeps<ThreadExecutionContext> = {
    projectId: 'project',
    threadId: 'thread',
    bridge: {
      setExecutionContext: (context) => {
        events.push(context ? 'bind' : 'unbind')
      },
      setTurnSignal: (signal) => {
        events.push(signal ? 'signal' : 'unsignal')
      },
      setPendingExecutionContext: (next) => {
        pending = next
      },
    },
    resolveContext: () => Promise.resolve(CONTEXT),
    confirmContinue: () => {
      events.push('confirm')
      return Promise.resolve(options.confirm ?? false)
    },
    beginWriter: () => {
      events.push('writer')
      return () => {
        events.push('writer-released')
      }
    },
    getAuthority: () => (options.authority === false ? null : authority),
    idleMs: 1_000,
  }
  return {
    lease: createAgentInitiatedTurnLease(deps),
    events,
    claimCalls,
    pending: () => pending,
  }
}

function granted(events: string[]): AgentInitiatedTurnClaim {
  return {
    status: 'granted',
    release: (): Promise<void> => {
      events.push('budget-released')
      return Promise.resolve()
    },
  }
}

describe('agent-initiated turn lease', () => {
  it('binds the thread context once the budget grants the turn, and releases everything at the end', async () => {
    const events: string[] = []
    const t = setup({ claims: [granted(events)] })
    t.lease.begin()
    assert.equal(await t.pending(), CONTEXT)
    t.lease.end()
    await Promise.resolve()
    assert.deepEqual(t.claimCalls, [false])
    assert.ok(t.events.includes('bind'))
    assert.ok(t.events.includes('writer'))
    assert.ok(t.events.indexOf('unbind') > t.events.indexOf('bind'))
    assert.ok(t.events.includes('writer-released'))
    assert.equal(t.pending(), null)
    assert.ok(events.includes('budget-released'))
  })

  it('holds an over-budget turn for the user, and only an explicit Allow binds it', async () => {
    const events: string[] = []
    const t = setup({
      claims: [{ status: 'budget-exhausted' }, granted(events)],
      confirm: true,
    })
    t.lease.begin()
    assert.equal(await t.pending(), CONTEXT)
    assert.deepEqual(t.claimCalls, [false, true])
    assert.ok(t.events.indexOf('confirm') < t.events.indexOf('bind'))
    t.lease.end()
  })

  it('never binds an over-budget turn the user declines', async () => {
    const t = setup({ claims: [{ status: 'budget-exhausted' }], confirm: false })
    t.lease.begin()
    assert.equal(await t.pending(), null)
    assert.deepEqual(t.claimCalls, [false])
    assert.ok(!t.events.includes('bind'))
    t.lease.end()
    assert.ok(!t.events.includes('unbind'), 'it must not clear a context it never set')
  })

  it('fails closed when no authority is installed', async () => {
    const t = setup({ claims: [], authority: false })
    t.lease.begin()
    assert.equal(await t.pending(), null)
    assert.ok(!t.events.includes('bind'))
    t.lease.end()
  })

  it('does not bind a turn that ended while its budget claim was in flight', async () => {
    const events: string[] = []
    let finishClaim!: (claim: AgentInitiatedTurnClaim) => void
    const claim = new Promise<AgentInitiatedTurnClaim>((resolve) => {
      finishClaim = resolve
    })
    const lease = createAgentInitiatedTurnLease({
      projectId: 'project',
      threadId: 'thread',
      bridge: {
        setExecutionContext: (context) => {
          events.push(context ? 'bind' : 'unbind')
        },
        setTurnSignal: () => {},
        setPendingExecutionContext: () => {},
      },
      resolveContext: () => Promise.resolve(CONTEXT),
      confirmContinue: () => Promise.resolve(false),
      beginWriter: () => (): void => {},
      getAuthority: () => ({
        claimAgentInitiatedTurn: (): Promise<AgentInitiatedTurnClaim> => claim,
      }),
    })
    lease.begin()
    lease.end()
    finishClaim({
      status: 'granted',
      release: (): Promise<void> => {
        events.push('budget-released')
        return Promise.resolve()
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(!events.includes('bind'))
    assert.ok(events.includes('budget-released'), 'a claim that arrives late is still released')
  })

  it('ends on its own after the idle window when the agent never marks the end', async () => {
    const events: string[] = []
    const t = setup({ claims: [granted(events)] })
    t.lease.begin()
    await t.pending()
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    assert.ok(t.events.includes('unbind'))
  })

  it('treats repeated begin as one turn', async () => {
    const events: string[] = []
    const t = setup({ claims: [granted(events), granted(events)] })
    t.lease.begin()
    t.lease.begin()
    await t.pending()
    assert.deepEqual(t.claimCalls, [false])
    t.lease.end()
  })

  it('reports whether a self-started turn is in progress', () => {
    const t = setup({ claims: [granted([])] })
    assert.equal(t.lease.isActive(), false)
    t.lease.begin()
    assert.equal(t.lease.isActive(), true)
    t.lease.end()
    assert.equal(t.lease.isActive(), false)
  })
})
