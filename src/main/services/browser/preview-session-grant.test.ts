import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grantPreviewSessionAccess } from './preview-session-grant.ts'

describe('preview browser session grants', () => {
  it('clears an existing worker before granting and again when a port is reused', async () => {
    const grants = new Map<string, string>()
    const origin = 'http://localhost:43123'
    let releaseClear = (): void => {}
    const cleared = new Promise<void>((resolve) => {
      releaseClear = (): void => {
        resolve()
      }
    })
    let clearCount = 0
    const first = grantPreviewSessionAccess(grants, origin, 'first-listener', () => {
      clearCount += 1
      return cleared
    })

    assert.equal(clearCount, 1)
    assert.equal(grants.has(origin), false)
    releaseClear()
    await first
    assert.equal(grants.get(origin), 'first-listener')

    await grantPreviewSessionAccess(grants, origin, 'first-listener', async () => {
      clearCount += 1
    })
    assert.equal(clearCount, 1)

    await grantPreviewSessionAccess(grants, origin, 'second-listener', async () => {
      clearCount += 1
    })
    assert.equal(clearCount, 2)
    assert.equal(grants.get(origin), 'second-listener')
  })
})
