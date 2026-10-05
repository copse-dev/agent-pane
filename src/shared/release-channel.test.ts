import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareReleaseVersions,
  getGitHubReleaseType,
  getPublishedUpdateChannels,
  getReleaseChannel,
  getUpdateChannel,
  getUpdateCheckPlan,
} from './release-channel.mts'

describe('release channel', () => {
  it('classifies stable versions as normal latest-channel releases', () => {
    assert.equal(getReleaseChannel('0.1.0'), 'stable')
    assert.equal(getUpdateChannel('12.34.56'), 'latest')
    assert.equal(getGitHubReleaseType('12.34.56'), 'release')
    assert.deepEqual(getPublishedUpdateChannels('12.34.56'), ['latest', 'beta'])
    assert.deepEqual(getUpdateCheckPlan('12.34.56', null)[0], {
      channel: 'latest',
      allowPrerelease: false,
      allowDowngrade: false,
    })
  })

  it('classifies numbered beta versions as beta-channel prereleases', () => {
    assert.equal(getReleaseChannel('0.1.0-beta.1'), 'beta')
    assert.equal(getUpdateChannel('12.34.56-beta.789'), 'beta')
    assert.equal(getGitHubReleaseType('12.34.56-beta.789'), 'prerelease')
    assert.deepEqual(getPublishedUpdateChannels('12.34.56-beta.789'), ['beta'])
    assert.deepEqual(getUpdateCheckPlan('12.34.56-beta.789', null)[0], {
      channel: 'beta',
      allowPrerelease: true,
      allowDowngrade: false,
    })
  })

  it('rejects versions outside the supported public channels', () => {
    for (const version of [
      '0.1.0-alpha.1',
      '0.1.0-rc.1',
      '0.1.0-beta',
      '0.1.0-beta.01',
      '01.0.0',
      'v0.1.0',
      '0.1.0+build.1',
      ' 0.1.0',
    ]) {
      assert.throws(() => getReleaseChannel(version), /Unsupported release version/)
    }
  })
})

describe('compareReleaseVersions', () => {
  it('orders betas numerically, not lexically', () => {
    assert.ok(compareReleaseVersions('0.1.0-beta.10', '0.1.0-beta.9') > 0)
  })

  it('orders a stable release after every beta of the same version', () => {
    assert.ok(compareReleaseVersions('0.1.0', '0.1.0-beta.99') > 0)
    assert.ok(compareReleaseVersions('0.1.0-beta.1', '0.1.0') < 0)
  })

  it('orders by major, minor, then patch', () => {
    assert.ok(compareReleaseVersions('1.0.0-beta.1', '0.9.9') > 0)
    assert.ok(compareReleaseVersions('0.2.0', '0.10.0') < 0)
    assert.equal(compareReleaseVersions('0.1.0-beta.3', '0.1.0-beta.3'), 0)
  })

  it('rejects a version shape neither channel supports', () => {
    assert.throws(
      () => compareReleaseVersions('0.1.0-rc.1', '0.1.0'),
      /Unsupported release version/,
    )
  })
})

describe('getUpdateCheckPlan', () => {
  const stable = { channel: 'latest', allowPrerelease: false, allowDowngrade: false }
  const beta = { channel: 'beta', allowPrerelease: true, allowDowngrade: false }

  it('follows the installed build’s own channel when nothing is chosen', () => {
    assert.deepEqual(getUpdateCheckPlan('0.1.0', null), [stable])
    assert.deepEqual(getUpdateCheckPlan('0.1.0-beta.13', null), [beta])
  })

  it('keeps a beta choice on the beta feed, from a beta or a stable build', () => {
    // The beta feed carries every stable release too, so beta testers still
    // receive stable builds and then carry on to the next beta.
    assert.deepEqual(getUpdateCheckPlan('0.1.0-beta.13', 'beta'), [beta])
    assert.deepEqual(getUpdateCheckPlan('0.1.0', 'beta'), [beta])
  })

  it('moves a beta build to stable at the next stable release, taking betas until then', () => {
    // Stable first, so a newer stable wins whenever one exists; otherwise the
    // newest beta, so switching never stalls updates. Neither step downgrades.
    assert.deepEqual(getUpdateCheckPlan('0.1.0-beta.13', 'stable'), [stable, beta])
  })

  it('keeps a stable build on stable releases only', () => {
    assert.deepEqual(getUpdateCheckPlan('0.1.0', 'stable'), [stable])
  })

  it('never allows a downgrade', () => {
    for (const version of ['0.1.0', '0.1.0-beta.13']) {
      for (const choice of [null, 'stable', 'beta'] as const) {
        for (const policy of getUpdateCheckPlan(version, choice)) {
          assert.equal(policy.allowDowngrade, false)
        }
      }
    }
  })

  it('rejects an unsupported installed version', () => {
    assert.throws(() => getUpdateCheckPlan('dev-1234567', 'stable'), /Unsupported release version/)
  })
})
