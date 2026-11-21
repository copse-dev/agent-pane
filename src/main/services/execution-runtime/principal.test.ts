import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_HUMAN_PRINCIPAL_ID } from '@shared/threads/execution-runtime.ts'
import {
  threadExecutionContextStorage,
  type ThreadExecutionContext,
} from '../thread-execution-context-store.ts'
import { currentExecutionPrincipal, resolveExecutionPrincipal } from './principal.ts'

const automation = { scheduleId: 'nightly', scheduleName: 'Nightly', triggeredAt: 1234 }

const context: ThreadExecutionContext = {
  projectId: 'p1',
  threadId: 't1',
  projectRoot: '/repo',
  root: '/repo',
  checkoutMode: 'shared',
  branch: null,
}

describe('resolveExecutionPrincipal', () => {
  it('resolves an interactive turn to the local human', () => {
    const principal = resolveExecutionPrincipal(context, () => true)
    assert.equal(principal.id, LOCAL_HUMAN_PRINCIPAL_ID)
    assert.equal(principal.kind, 'human')
    assert.equal(principal.projectId, 'p1')
  })

  it('resolves a corroborated automation run to its own principal', () => {
    const seen: unknown[] = []
    const principal = resolveExecutionPrincipal({ ...context, automation }, (...args) => {
      seen.push(args)
      return true
    })
    assert.deepEqual(seen, [['p1', 't1', automation]])
    assert.equal(principal.kind, 'automation')
    assert.equal(principal.id, 'automation:nightly@1234')
    assert.equal(principal.workflowId, 'nightly')
  })

  it('never promotes an uncorroborated automation claim', () => {
    assert.equal(resolveExecutionPrincipal({ ...context, automation }, () => false).kind, 'human')
    assert.equal(resolveExecutionPrincipal({ ...context, automation }, null).kind, 'human')
  })
})

describe('currentExecutionPrincipal', () => {
  it('is null outside a turn', () => {
    assert.equal(currentExecutionPrincipal(), null)
  })

  it('answers only for the turn that owns the record', () => {
    threadExecutionContextStorage.run(context, () => {
      assert.equal(currentExecutionPrincipal({ projectId: 'p1', threadId: 't1' })?.kind, 'human')
      assert.equal(currentExecutionPrincipal({ projectId: 'p1', threadId: 'other' }), null)
    })
  })
})
