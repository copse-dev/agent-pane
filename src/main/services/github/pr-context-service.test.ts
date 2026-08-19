import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { branchHasOpenPr } from './pr-context-service.ts'
import { setGhAvailableForTest } from '../tool-availability.ts'

describe('branchHasOpenPr', () => {
  after(() => {
    setGhAvailableForTest(null)
  })

  it('answers "no PR" without spawning when gh is unavailable', async () => {
    setGhAvailableForTest(false)
    assert.equal(await branchHasOpenPr('project-1', 'feature', '/tmp/repo'), false)
  })

  it('answers "no PR" outside a workspace', async () => {
    setGhAvailableForTest(true)
    assert.equal(await branchHasOpenPr('project-1', 'feature', null), false)
  })
})
