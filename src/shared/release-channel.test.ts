import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getAutoUpdatePolicy,
  getGitHubReleaseType,
  getPublishedUpdateChannels,
  getReleaseChannel,
  getUpdateChannel,
} from './release-channel.mts'

describe('release channel', () => {
  it('classifies stable versions as normal latest-channel releases', () => {
    assert.equal(getReleaseChannel('0.1.0'), 'stable')
    assert.equal(getUpdateChannel('12.34.56'), 'latest')
    assert.equal(getGitHubReleaseType('12.34.56'), 'release')
    assert.deepEqual(getPublishedUpdateChannels('12.34.56'), ['latest', 'beta'])
    assert.deepEqual(getAutoUpdatePolicy('12.34.56'), {
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
    assert.deepEqual(getAutoUpdatePolicy('12.34.56-beta.789'), {
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
