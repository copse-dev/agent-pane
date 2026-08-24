import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickCooledRelease } from './sync-acp-registry.mts'

const ASSET = [{ name: 'registry.json' }]
const NOW = new Date('2026-08-24T12:00:00Z')

interface FakeRelease {
  tag_name: string
  published_at: string
  assets: { name: string }[]
}

function release(tag: string, publishedAt: string, assets = ASSET): FakeRelease {
  return { tag_name: tag, published_at: publishedAt, assets }
}

describe('pickCooledRelease', () => {
  it('picks the newest release at least cooldownDays old', () => {
    const releases = [
      release('v-today', '2026-08-24T00:00:00Z'),
      release('v-3d', '2026-08-21T00:00:00Z'),
      release('v-8d', '2026-08-16T00:00:00Z'),
      release('v-20d', '2026-08-04T00:00:00Z'),
    ]
    assert.equal(pickCooledRelease(releases, NOW, 7)?.tag_name, 'v-8d')
  })

  it('treats the cooldown boundary as inclusive (exactly N days old qualifies)', () => {
    const releases = [release('v-exact', '2026-08-17T12:00:00Z')]
    assert.equal(pickCooledRelease(releases, NOW, 7)?.tag_name, 'v-exact')
    // One second younger than the cooldown does not.
    assert.equal(pickCooledRelease([release('v-close', '2026-08-17T12:00:01Z')], NOW, 7), null)
  })

  it('skips releases without a registry.json asset', () => {
    const releases = [
      release('v-newer-no-asset', '2026-08-15T00:00:00Z', [{ name: 'icons.zip' }]),
      release('v-older-with-asset', '2026-08-10T00:00:00Z'),
    ]
    assert.equal(pickCooledRelease(releases, NOW, 7)?.tag_name, 'v-older-with-asset')
  })

  it('returns null when nothing has cooled', () => {
    assert.equal(pickCooledRelease([release('v-new', '2026-08-23T00:00:00Z')], NOW, 7), null)
  })

  it('orders by publish time, not array position', () => {
    const releases = [
      release('v-older', '2026-08-10T00:00:00Z'),
      release('v-newer', '2026-08-14T00:00:00Z'),
    ]
    assert.equal(pickCooledRelease(releases, NOW, 7)?.tag_name, 'v-newer')
  })
})
