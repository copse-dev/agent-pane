import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  clearActiveRunThread,
  clearThreadModels,
  getActiveRunModel,
  getActiveRunThread,
  getActiveRunTurnTreeId,
  getThreadModels,
  recordThreadModel,
  runWithActiveRunIdentity,
  setActiveRunModel,
  setActiveRunThread,
  setActiveRunTurnTreeId,
} from './thread-models.ts'

afterEach(() => {
  clearThreadModels('t1')
  clearThreadModels('t2')
})

describe('thread model tracking', () => {
  it('accumulates distinct models per thread in first-seen order', () => {
    recordThreadModel('t1', 'claude-opus-4-8')
    recordThreadModel('t1', 'gpt-4o')
    recordThreadModel('t1', 'claude-opus-4-8')
    assert.deepEqual(getThreadModels('t1'), ['claude-opus-4-8', 'gpt-4o'])
  })

  it('keeps threads isolated and ignores blank ids', () => {
    recordThreadModel('t1', 'claude-opus-4-8')
    recordThreadModel('t2', 'gpt-4o')
    recordThreadModel('t2', '')
    assert.deepEqual(getThreadModels('t2'), ['gpt-4o'])
    assert.deepEqual(getThreadModels('unknown'), [])
  })
})

describe('active run identity', () => {
  it('is absent outside a run and rejects an unbound setter', () => {
    assert.equal(getActiveRunThread(), null)
    assert.equal(getActiveRunModel(), null)
    assert.equal(getActiveRunTurnTreeId(), null)
    assert.throws(() => {
      setActiveRunThread('t1')
    }, /No active run identity context/)
  })

  it('carries and clears the human-originated turn-tree epoch', () => {
    runWithActiveRunIdentity('t1', () => {
      const turnTreeId = asTurnTreeId('tree-1')
      setActiveRunTurnTreeId(turnTreeId)
      assert.equal(getActiveRunTurnTreeId(), turnTreeId)
      clearActiveRunThread('t1')
      assert.equal(getActiveRunTurnTreeId(), null)
    })
  })

  it('keeps thread and model attribution isolated across interleaved runs', async () => {
    let releaseFirst: (() => void) | undefined
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted: (() => void) | undefined
    const firstIsRunning = new Promise<void>((resolve) => {
      firstStarted = resolve
    })

    const first = runWithActiveRunIdentity('t1', async () => {
      setActiveRunThread('t1')
      setActiveRunModel('claude-opus-4-8')
      firstStarted?.()
      await firstCanFinish
      return { threadId: getActiveRunThread(), model: getActiveRunModel() }
    })
    await firstIsRunning

    const second = await runWithActiveRunIdentity('t2', async () => {
      setActiveRunThread('t2')
      setActiveRunModel('gpt-4o')
      await Promise.resolve()
      return { threadId: getActiveRunThread(), model: getActiveRunModel() }
    })
    releaseFirst?.()

    assert.deepEqual(second, { threadId: 't2', model: 'gpt-4o' })
    assert.deepEqual(await first, { threadId: 't1', model: 'claude-opus-4-8' })
    assert.equal(getActiveRunThread(), null)
    assert.equal(getActiveRunModel(), null)
  })

  it('clears model state only for its owning thread', () => {
    runWithActiveRunIdentity('t1', () => {
      setActiveRunModel('gpt-4o')
      clearActiveRunThread('t2')
      assert.equal(getActiveRunModel(), 'gpt-4o')
      clearActiveRunThread('t1')
      assert.equal(getActiveRunModel(), null)
    })
  })
})
