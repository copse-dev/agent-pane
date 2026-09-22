import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewContainerBackend, type ReviewContainerProbe } from './container-backend.ts'

function probe(overrides: Partial<ReviewContainerProbe> = {}): ReviewContainerProbe {
  return {
    platform: 'darwin',
    dockerAvailable: () => Promise.resolve(true),
    wantedFingerprint: () => 'fp-1',
    imageFingerprint: () => Promise.resolve('fp-1'),
    ...overrides,
  }
}

describe('review container backend (app)', () => {
  it('is the runtime image under the runtime naming when everything is in place', async () => {
    const detection = await createReviewContainerBackend(probe())
    assert.equal(detection.reason, null)
    assert.ok(detection.backend)
    assert.equal(detection.backend.id, 'container')
    assert.equal(detection.backend.strength, 'container')
  })

  it('says why it is unavailable: platform, daemon, bundle, image, version', async () => {
    const cases: [Partial<ReviewContainerProbe>, RegExp][] = [
      [{ platform: 'win32' }, /POSIX host/],
      [{ dockerAvailable: () => Promise.resolve(false) }, /Docker is not running/],
      [
        {
          wantedFingerprint: (): string => {
            throw new Error('missing bundle')
          },
        },
        /worker bundle is not built/,
      ],
      [{ imageFingerprint: () => Promise.resolve(null) }, /is not built; start a container run/],
      [{ imageFingerprint: () => Promise.resolve('fp-0') }, /another version of Copse/],
    ]
    for (const [overrides, expected] of cases) {
      const detection = await createReviewContainerBackend(probe(overrides))
      assert.equal(detection.backend, null)
      assert.match(detection.reason ?? '', expected)
    }
  })
})
