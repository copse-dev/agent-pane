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
    assert.equal(isRendererWritableSettingKey('localServerUrl'), false)
    assert.equal(isRendererWritableSettingKey('safetyClassifierEnabled'), false)
    assert.equal(isRendererWritableSettingKey('safetyConfidenceThreshold'), false)
    assert.equal(isRendererWritableSettingKey('mcpAutoAllowReadOnly'), false)
  })

  it('allows benign UI keys', () => {
    assert.equal(isRendererWritableSettingKey('model'), true)
    assert.equal(isRendererWritableSettingKey('appIconVariant'), true)
    assert.equal(isRendererWritableSettingKey('autoPortraitRightPanel'), true)
    assert.equal(parseRendererWritableSetting('theme', 'dark'), 'dark')
    assert.equal(parseRendererWritableSetting('appIconVariant', 'wave'), 'wave')
    assert.equal(parseRendererWritableSetting('autoPortraitRightPanel', false), false)
  })

  it('parses security settings bundle', () => {
    const parsed = securitySettingsSchema.parse({
      localServerUrl: 'http://127.0.0.1:1234/v1',
      safetyClassifierEnabled: true,
      safetyConfidenceThreshold: 0.85,
      safetyModel: '',
      autoRunSandboxCommands: false,
      mcpAutoAllowReadOnly: true,
      cursorHooksEnabled: false,
      webAllowedOrigins: ['https://duckduckgo.com', 'http://localhost:*'],
      webAllowUserApproval: true,
    })
    assert.equal(parsed.localServerUrl, 'http://127.0.0.1:1234/v1')
    assert.deepEqual(parsed.webAllowedOrigins, ['https://duckduckgo.com', 'http://localhost:*'])
  })

  it('rejects malformed web origins in the security bundle', () => {
    assert.throws(() =>
      securitySettingsSchema.parse({
        localServerUrl: '',
        safetyClassifierEnabled: true,
        safetyConfidenceThreshold: 0.85,
        safetyModel: '',
        autoRunSandboxCommands: true,
        mcpAutoAllowReadOnly: false,
        cursorHooksEnabled: false,
        webAllowedOrigins: ['https://example.com/path'],
        webAllowUserApproval: true,
      }),
    )
  })
})
