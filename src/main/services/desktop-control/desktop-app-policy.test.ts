import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideDesktopAppAccess, isValidBundleId } from './desktop-app-policy.ts'
import { desktopKeyCode } from './desktop-keys.ts'

describe('decideDesktopAppAccess', () => {
  it('denies terminals, Copse, password managers and security prompts even when saved as allowed', () => {
    for (const bundleId of [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'dev.copse.app',
      'dev.copse.desktop-control',
      'com.1password.1password',
      'com.apple.SecurityAgent',
    ]) {
      const decision = decideDesktopAppAccess({ bundleId, allowedBundleIds: [bundleId] })
      assert.equal(decision.action, 'deny', bundleId)
    }
  })

  it('prompts for an unknown app and allows a saved or thread-approved one', () => {
    assert.deepEqual(
      decideDesktopAppAccess({ bundleId: 'com.apple.Notes', allowedBundleIds: [] }),
      {
        action: 'prompt',
      },
    )
    assert.deepEqual(
      decideDesktopAppAccess({
        bundleId: 'com.apple.Notes',
        allowedBundleIds: ['com.apple.Notes'],
      }),
      { action: 'allow' },
    )
    assert.deepEqual(
      decideDesktopAppAccess({
        bundleId: 'com.apple.Notes',
        allowedBundleIds: [],
        sessionBundleIds: new Set(['com.apple.Notes']),
      }),
      { action: 'allow' },
    )
  })

  it('denies malformed bundle ids instead of prompting with them', () => {
    assert.equal(isValidBundleId(''), false)
    assert.equal(isValidBundleId('com.apple.Notes; rm -rf'), false)
    assert.equal(decideDesktopAppAccess({ bundleId: '../x', allowedBundleIds: [] }).action, 'deny')
  })
})

describe('desktopKeyCode', () => {
  it('maps names case- and separator-insensitively and rejects unknown keys', () => {
    assert.equal(desktopKeyCode('Return'), 36)
    assert.equal(desktopKeyCode('page down'), 121)
    assert.equal(desktopKeyCode('forward-delete'), 117)
    assert.equal(desktopKeyCode('-'), 27)
    assert.equal(desktopKeyCode('toString'), undefined)
    assert.equal(desktopKeyCode('hyper'), undefined)
  })
})
