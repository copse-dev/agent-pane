import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chosenUpdateChannel, isReleaseChannel } from './update-channel-choice.ts'

describe('chosenUpdateChannel', () => {
  it('uses a saved channel and does not ask to remember it again', () => {
    assert.deepEqual(chosenUpdateChannel('stable', '0.1.0-beta.13'), {
      channel: 'stable',
      remember: false,
    })
    assert.deepEqual(chosenUpdateChannel('beta', '0.1.0'), { channel: 'beta', remember: false })
  })

  it('remembers the installed build’s channel when nothing valid is saved', () => {
    // A beta tester's first launch saves `beta`, so a stable release that
    // later reaches them through the beta feed does not move them off beta.
    for (const saved of [undefined, null, '', 'latest', 'nightly', 42]) {
      assert.deepEqual(chosenUpdateChannel(saved, '0.1.0-beta.13'), {
        channel: 'beta',
        remember: true,
      })
    }
    assert.deepEqual(chosenUpdateChannel(undefined, '0.1.0'), { channel: 'stable', remember: true })
  })

  it('throws for an unsupported installed version with nothing saved', () => {
    assert.throws(
      () => chosenUpdateChannel(undefined, 'dev-1234567'),
      /Unsupported release version/,
    )
  })
})

describe('isReleaseChannel', () => {
  it('accepts exactly the two release channels', () => {
    assert.equal(isReleaseChannel('stable'), true)
    assert.equal(isReleaseChannel('beta'), true)
    assert.equal(isReleaseChannel('latest'), false)
    assert.equal(isReleaseChannel('Beta'), false)
  })
})
