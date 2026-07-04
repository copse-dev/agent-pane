import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectLmStudioInstall } from './lm-studio-setup.ts'

describe('detectLmStudioInstall', () => {
  it('returns a boolean without throwing', () => {
    assert.equal(typeof detectLmStudioInstall(), 'boolean')
  })
})
