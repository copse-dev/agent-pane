import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearWorkspaceTrustForTest,
  isWorkspaceTrusted,
  setWorkspaceTrusted,
} from './workspace-trust.ts'

describe('workspace trust gate (#100)', () => {
  let dir: string

  beforeEach(() => {
    clearWorkspaceTrustForTest()
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'trust-')))
  })

  afterEach(() => {
    clearWorkspaceTrustForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a freshly opened workspace is untrusted by default', () => {
    assert.equal(isWorkspaceTrusted(dir), false)
  })

  it('null/undefined roots are never trusted', () => {
    assert.equal(isWorkspaceTrusted(null), false)
    assert.equal(isWorkspaceTrusted(undefined), false)
  })

  it('trust persists and can be revoked', () => {
    setWorkspaceTrusted(dir, true)
    assert.equal(isWorkspaceTrusted(dir), true)
    setWorkspaceTrusted(dir, false)
    assert.equal(isWorkspaceTrusted(dir), false)
  })

  it('trust is keyed by canonical (realpath) root', () => {
    setWorkspaceTrusted(dir, true)
    // A non-canonical form of the same dir resolves to the same trust entry.
    assert.equal(isWorkspaceTrusted(join(dir, '.', '')), true)
  })

  it('trusting one workspace does not trust a sibling', () => {
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'trust-')))
    try {
      setWorkspaceTrusted(dir, true)
      assert.equal(isWorkspaceTrusted(other), false)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
