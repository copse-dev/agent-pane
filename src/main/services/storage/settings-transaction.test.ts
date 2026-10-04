import type { z } from 'zod'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import type { MAIN_ONLY_SETTING_SCHEMAS } from './settings-schema.ts'
import type { RENDERER_WRITABLE_SETTING_SCHEMAS } from './settings-writable.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getSettingsSnapshot, updateSettings } from './settings-transaction.ts'
import { getSetting, setSetting, setApiKey, updateSetting } from './settings.ts'
import { runWithExplicitSettings } from './settings-context.ts'

type ReadableSchemas = typeof MAIN_ONLY_SETTING_SCHEMAS & typeof RENDERER_WRITABLE_SETTING_SCHEMAS
type SchemaSnapshot = { [K in keyof ReadableSchemas]?: z.output<ReadableSchemas[K]> | undefined }
type SchemaUpdate = {
  -readonly [K in Exclude<keyof typeof RENDERER_WRITABLE_SETTING_SCHEMAS, 'trustedSshHosts'>]?:
    | z.output<(typeof RENDERER_WRITABLE_SETTING_SCHEMAS)[K]>
    | undefined
} & { roleAssignments?: Record<string, string> | undefined }

// Both directions catch narrowed values as well as missing or extra wire fields.
type SameContract<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('ordinary Settings transaction boundary', () => {
  it('keeps the pure wire contract aligned with host validation schemas', () => {
    const snapshotMatches: SameContract<SettingsSnapshot, SchemaSnapshot> = true
    const snapshotKeysMatch: SameContract<keyof SettingsSnapshot, keyof SchemaSnapshot> = true
    const updateMatches: SameContract<SettingsUpdate, SchemaUpdate> = true
    const updateKeysMatch: SameContract<keyof SettingsUpdate, keyof SchemaUpdate> = true
    assert.deepEqual(
      [snapshotMatches, snapshotKeysMatch, updateMatches, updateKeysMatch],
      [true, true, true, true],
    )
  })
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
  it('preserves a valid null fee while omitting missing and invalid snapshot values', async () => {
    await updateSettings({ claudePlanMonthlyFeeUsd: null })
    const persisted = getSettingsSnapshot()
    assert.ok(Object.hasOwn(persisted, 'claudePlanMonthlyFeeUsd'))
    assert.equal(persisted.claudePlanMonthlyFeeUsd, null)

    for (const values of [
      { claudePlanMonthlyFeeUsd: null },
      {},
      { claudePlanMonthlyFeeUsd: 'corrupt' },
    ]) {
      await runWithExplicitSettings({ values }, () => {
        const snapshot = getSettingsSnapshot()
        assert.equal(
          Object.hasOwn(snapshot, 'claudePlanMonthlyFeeUsd'),
          Object.hasOwn(values, 'claudePlanMonthlyFeeUsd') &&
            values.claudePlanMonthlyFeeUsd === null,
        )
        if (values.claudePlanMonthlyFeeUsd === null) {
          assert.equal(snapshot.claudePlanMonthlyFeeUsd, null)
        }
      })
    }
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
