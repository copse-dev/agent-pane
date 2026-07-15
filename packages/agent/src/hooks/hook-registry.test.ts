import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HookRegistry,
  HookExecutionError,
  createHookRegistry,
  mergeBlockingOutcomes,
  FIRST_PARTY_HOOKS,
  type HookOutcomeRecord,
} from './hook-registry.ts'
import { HOOK_EVENT_NAMES, HOOK_EVENT_SPECS, type BlockingHook } from './canonical-events.ts'
import type { AsyncHookOutcome } from './hook-outcome.ts'

const emptyContext = {}

const turnStartPayload = { userText: 'do the thing', priorTodos: [] as const }
const finalizePayload = { openTodos: [] as const, attempt: 0 }

describe('canonical event catalogue', () => {
  it('wires exactly the two blocking assembly events for M0.1', () => {
    assert.deepEqual([...HOOK_EVENT_NAMES], ['turnStart', 'beforeFinalize'])
    for (const name of HOOK_EVENT_NAMES) {
      assert.equal(HOOK_EVENT_SPECS[name].dispatch, 'blocking')
      assert.equal(HOOK_EVENT_SPECS[name].role, 'assembly')
    }
  })
})

describe('HookRegistry.emit — zero registered hooks changes nothing', () => {
  it('resolves to an empty result for an event with no hooks', async () => {
    const registry = new HookRegistry()
    const result = await registry.emit('turnStart', turnStartPayload, emptyContext)
    assert.deepEqual(result.outcomes, [])
  })

  it('the static first-party list is empty in M0.1, so the default registry is inert', async () => {
    assert.equal(FIRST_PARTY_HOOKS.length, 0)
    const registry = createHookRegistry()
    assert.deepEqual(
      (await registry.emit('turnStart', turnStartPayload, emptyContext)).outcomes,
      [],
    )
    assert.deepEqual(
      (await registry.emit('beforeFinalize', finalizePayload, emptyContext)).outcomes,
      [],
    )
  })
})

describe('HookRegistry.emit — function executor', () => {
  it('runs hooks in registration order and records each returned outcome', async () => {
    const registry = new HookRegistry()
    const order: string[] = []
    registry.register({
      id: 'first',
      event: 'turnStart',
      run: () => {
        order.push('first')
        return { injectContext: 'A' }
      },
    })
    registry.register({
      id: 'second',
      event: 'turnStart',
      run: () => {
        order.push('second')
        return { injectContext: 'B' }
      },
    })

    const result = await registry.emit('turnStart', turnStartPayload, emptyContext)
    assert.deepEqual(order, ['first', 'second'])
    assert.deepEqual(result.outcomes, [
      { hookId: 'first', outcome: { injectContext: 'A' } },
      { hookId: 'second', outcome: { injectContext: 'B' } },
    ])
  })

  it('omits hooks that abstain (return void)', async () => {
    const registry = new HookRegistry()
    registry.register({ id: 'noop', event: 'beforeFinalize', run: () => undefined })
    registry.register({ id: 'opinion', event: 'beforeFinalize', run: () => ({ decision: 'deny' }) })

    const result = await registry.emit('beforeFinalize', finalizePayload, emptyContext)
    assert.deepEqual(result.outcomes, [{ hookId: 'opinion', outcome: { decision: 'deny' } }])
  })

  it('awaits async hook handlers', async () => {
    const registry = new HookRegistry()
    registry.register({
      id: 'async',
      event: 'turnStart',
      run: async () => Promise.resolve({ injectContext: 'later' }),
    })
    const result = await registry.emit('turnStart', turnStartPayload, emptyContext)
    assert.deepEqual(result.outcomes, [{ hookId: 'async', outcome: { injectContext: 'later' } }])
  })

  it('only dispatches hooks registered for the fired event', async () => {
    const registry = new HookRegistry()
    registry.register({ id: 't', event: 'turnStart', run: () => ({ injectContext: 'T' }) })
    registry.register({ id: 'f', event: 'beforeFinalize', run: () => ({ injectContext: 'F' }) })

    const result = await registry.emit('turnStart', turnStartPayload, emptyContext)
    assert.deepEqual(result.outcomes, [{ hookId: 't', outcome: { injectContext: 'T' } }])
    assert.deepEqual(
      registry.hooksFor('beforeFinalize').map((h) => h.id),
      ['f'],
    )
  })

  it('stops dispatching once the run is aborted', async () => {
    const registry = new HookRegistry()
    const controller = new AbortController()
    const seen: string[] = []
    registry.register({
      id: 'aborts',
      event: 'turnStart',
      run: () => {
        seen.push('aborts')
        controller.abort()
        return { injectContext: 'A' }
      },
    })
    registry.register({
      id: 'skipped',
      event: 'turnStart',
      run: () => {
        seen.push('skipped')
        return { injectContext: 'B' }
      },
    })

    const result = await registry.emit('turnStart', turnStartPayload, { signal: controller.signal })
    assert.deepEqual(seen, ['aborts'])
    assert.deepEqual(result.outcomes, [{ hookId: 'aborts', outcome: { injectContext: 'A' } }])
  })
})

describe('HookRegistry.emit — fail-hard (decision 9)', () => {
  it('propagates a throwing hook as HookExecutionError, never swallowing it', async () => {
    const registry = new HookRegistry()
    const boom = new Error('kaboom')
    registry.register({
      id: 'thrower',
      event: 'turnStart',
      run: () => {
        throw boom
      },
    })

    await assert.rejects(
      () => registry.emit('turnStart', turnStartPayload, emptyContext),
      (err: unknown) => {
        assert.ok(err instanceof HookExecutionError)
        assert.equal(err.hookId, 'thrower')
        assert.equal(err.event, 'turnStart')
        assert.equal(err.cause, boom)
        return true
      },
    )
  })
})

describe('HookRegistry — extensibility (M0 acceptance)', () => {
  it('registering an additional no-op hook needs no loop code and leaves other hooks intact', async () => {
    const registry = new HookRegistry()
    registry.register({
      id: 'existing',
      event: 'turnStart',
      run: () => ({ injectContext: 'keep' }),
    })

    // The extensibility proof: a brand-new hook slots into the same seam.
    let called = false
    const extra: BlockingHook<'turnStart'> = {
      id: 'brand-new-noop',
      event: 'turnStart',
      run: () => {
        called = true
        return undefined
      },
    }
    registry.register(extra)

    const result = await registry.emit('turnStart', turnStartPayload, emptyContext)
    assert.equal(called, true)
    assert.deepEqual(result.outcomes, [{ hookId: 'existing', outcome: { injectContext: 'keep' } }])
  })
})

describe('mergeBlockingOutcomes', () => {
  const record = (hookId: string, outcome: HookOutcomeRecord['outcome']): HookOutcomeRecord => ({
    hookId,
    outcome,
  })

  it('is empty for no records', () => {
    assert.deepEqual(mergeBlockingOutcomes([]), {})
  })

  it('concatenates injected context in order', () => {
    const merged = mergeBlockingOutcomes([
      record('a', { injectContext: 'first' }),
      record('b', { injectContext: 'second' }),
    ])
    assert.deepEqual(merged, { injectContext: 'first\n\nsecond' })
  })

  it('first haltRun wins and outranks nothing else being dropped', () => {
    const merged = mergeBlockingOutcomes([
      record('a', { haltRun: { reason: 'one' }, injectContext: 'ctx' }),
      record('b', { haltRun: { reason: 'two' } }),
    ])
    assert.deepEqual(merged, { haltRun: { reason: 'one' }, injectContext: 'ctx' })
  })

  it('keeps the most restrictive decision', () => {
    assert.deepEqual(
      mergeBlockingOutcomes([
        record('a', { decision: 'allow' }),
        record('b', { decision: 'deny' }),
      ]),
      { decision: 'deny' },
    )
    assert.deepEqual(
      mergeBlockingOutcomes([record('a', { decision: 'ask' }), record('b', { decision: 'allow' })]),
      { decision: 'ask' },
    )
  })

  it('shallow-merges updatedInput in registration order', () => {
    const merged = mergeBlockingOutcomes([
      record('a', { updatedInput: { command: 'ls', flag: 1 } }),
      record('b', { updatedInput: { flag: 2 } }),
    ])
    assert.deepEqual(merged, { updatedInput: { command: 'ls', flag: 2 } })
  })
})

// Decision 11 as a compile-time guard (execution-guidance rule 3): an async
// hook's outcome type must NOT carry `decision`, `updatedInput`, or
// `injectContext`. Each `@ts-expect-error` below fails the typecheck if that
// property ever becomes assignable — the type-level contract test the plan calls
// for. One object per property because excess-property checking only reports the
// first offender in a single literal. `void` keeps each value used under
// `noUnusedLocals`.
const asyncCannotDecide: AsyncHookOutcome = {
  // @ts-expect-error `decision` is blocking-only (decisions 4 & 11)
  decision: 'allow',
}
const asyncCannotRewriteInput: AsyncHookOutcome = {
  // @ts-expect-error `updatedInput` is blocking-only (decisions 4 & 11)
  updatedInput: {},
}
const asyncCannotInjectContext: AsyncHookOutcome = {
  // @ts-expect-error `injectContext` is blocking-only (decision 11)
  injectContext: 'nope',
}
void asyncCannotDecide
void asyncCannotRewriteInput
void asyncCannotInjectContext
