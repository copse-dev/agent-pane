import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRendererWritableSettingKey,
  parseRendererWritableSetting,
  securitySettingsSchema,
} from './settings-writable.ts'

describe('settings-writable', () => {
  it('rejects security keys on the renderer allowlist', () => {
    assert.equal(isRendererWritableSettingKey('autoRunSandboxCommands'), false)
    assert.equal(isRendererWritableSettingKey('lmStudioUrl'), false)
    assert.equal(isRendererWritableSettingKey('lmStudioSafetyEnabled'), false)
    assert.equal(isRendererWritableSettingKey('lmStudioSafetyConfidenceThreshold'), false)
    assert.equal(isRendererWritableSettingKey('mcpAutoAllowReadOnly'), false)
  })

  it('allows benign UI keys', () => {
    assert.equal(isRendererWritableSettingKey('model'), true)
    assert.equal(isRendererWritableSettingKey('appIconVariant'), true)
    assert.equal(parseRendererWritableSetting('theme', 'dark'), 'dark')
    assert.equal(parseRendererWritableSetting('appIconVariant', 'wave'), 'wave')
  })

  it('parses security settings bundle', () => {
    const parsed = securitySettingsSchema.parse({
      lmStudioUrl: 'http://127.0.0.1:1234/v1',
      lmStudioSafetyEnabled: true,
      lmStudioSafetyConfidenceThreshold: 0.85,
      lmStudioSafetyModel: '',
      autoRunSandboxCommands: false,
      mcpAutoAllowReadOnly: true,
    })
    assert.equal(parsed.lmStudioUrl, 'http://127.0.0.1:1234/v1')
  })
})
