import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearProviderKeyStatusCache,
  invalidateProviderKeyStatus,
  isProviderKeyUsable,
  recordProviderKeyValidation,
} from './provider-key-status.ts'
import { setApiKey, deleteApiKey } from '../storage/settings.ts'

describe('provider-key-status', () => {
  beforeEach(() => {
    clearProviderKeyStatusCache()
    deleteApiKey('cursor')
  })

  it('returns false when no key is configured', async () => {
    assert.equal(await isProviderKeyUsable('cursor'), false)
  })

  it('returns a recorded validation result when a key is present', async () => {
    setApiKey('cursor', 'cur_test_key')
    recordProviderKeyValidation('cursor', true)
    assert.equal(await isProviderKeyUsable('cursor'), true)
  })

  it('drops cached validation when invalidated', async () => {
    setApiKey('cursor', 'cur_test_key')
    recordProviderKeyValidation('cursor', true)
    invalidateProviderKeyStatus('cursor')
    deleteApiKey('cursor')
    assert.equal(await isProviderKeyUsable('cursor'), false)
  })
})
