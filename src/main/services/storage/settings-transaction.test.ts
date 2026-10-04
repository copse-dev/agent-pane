import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getSettingsSnapshot, updateSettings } from './settings-transaction.ts'
import { getSetting, setSetting, setApiKey, updateSetting } from './settings.ts'
import { runWithExplicitSettings } from './settings-context.ts'

describe('ordinary Settings transaction boundary', () => {
  it('uses explicit profiles for reads and rejects all writes inside them', async () => {
    await runWithExplicitSettings(
      { values: { theme: 'light', fontSize: 'corrupt' }, apiKeys: { openai: 'profile-secret' } },
      async () => {
        const snapshot = getSettingsSnapshot()
        assert.equal(snapshot.theme, 'light')
        assert.equal(snapshot.fontSize, undefined)
        assert.ok(!JSON.stringify(snapshot).includes('profile-secret'))
        await assert.rejects(
          updateSettings({ theme: 'dark', roleAssignments: { coder: 'gpt-4o' } }),
          /explicit settings profile/,
        )
      },
    )
  })
  it('rejects an invalid later field without writing the earlier valid field', async () => {
    await setSetting('theme', 'dark')
    await setSetting('fontSize', 14)
    await assert.rejects(updateSettings({ theme: 'light', fontSize: -10 }))
    assert.equal(getSetting('theme', ''), 'dark')
    assert.equal(getSetting('fontSize', 0), 14)
  })

  it('rejects security, secret, unknown and inherited keys as a complete batch', async () => {
    await setSetting('theme', 'dark')
    for (const key of [
      'localServerUrl',
      'trustedSshHosts',
      'autoRunSandboxCommands',
      'apiKey.openai',
      'unknown',
      'constructor',
      '__proto__',
    ]) {
      await assert.rejects(
        updateSettings(
          Object.fromEntries([
            ['theme', 'light'],
            [key, true],
          ]),
        ),
      )
      assert.equal(getSetting('theme', ''), 'dark', key)
    }
  })

  it('reads a validated nonsecret snapshot without enumerating stored credentials', async () => {
    setApiKey('openai', 'private-key')
    await setSetting('theme', 'light')
    const snapshot = getSettingsSnapshot()
    assert.equal(snapshot.theme, 'light')
    assert.ok(!Object.keys(snapshot).some((key) => key.startsWith('apiKey')))
    assert.ok(!JSON.stringify(snapshot).includes('private-key'))
  })

  it('commits a valid patch and preserves preferences outside it', async () => {
    await setSetting('customInstructions', 'keep this')
    await updateSettings({ theme: 'dark', fontSize: 16, alertSound: false })
    assert.equal(getSetting('theme', ''), 'dark')
    assert.equal(getSetting('fontSize', 0), 16)
    assert.equal(getSetting('alertSound', true), false)
    assert.equal(getSetting('customInstructions', ''), 'keep this')
  })

  it('merges role assignments with the latest queued recovery without losing other roles', async () => {
    await setSetting('roleModels', { coder: 'old', research: 'old', review: 'keep' })
    const recovery = updateSetting('roleModels', {}, (current) => ({
      ...current,
      research: 'recovered',
    }))
    const save = updateSettings({ theme: 'light', roleAssignments: { coder: 'chosen' } })
    await Promise.all([recovery, save])
    assert.deepEqual(getSetting('roleModels', {}), {
      coder: 'chosen',
      research: 'recovered',
      review: 'keep',
    })
    await assert.rejects(updateSettings({ roleModels: {}, roleAssignments: { coder: 'other' } }))
  })
})
