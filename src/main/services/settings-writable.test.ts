import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRendererWritableSettingKey,
  isSecretSettingKey,
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

  it('parses the renderer bundle without cursorHooksEnabled (storage-only, no UI yet)', () => {
    const parsed = securitySettingsSchema.parse({
      localServerUrl: 'http://127.0.0.1:1234/v1',
      safetyClassifierEnabled: true,
      safetyConfidenceThreshold: 0.85,
      safetyModel: '',
      autoRunSandboxCommands: false,
      mcpAutoAllowReadOnly: true,
      webAllowedOrigins: ['https://duckduckgo.com'],
      webAllowUserApproval: true,
    })
    assert.equal(parsed.cursorHooksEnabled, undefined)
    assert.equal('cursorHooksEnabled' in parsed, false)
  })

  it('treats api-key records as secret (not readable via settings:get)', () => {
    assert.equal(isSecretSettingKey('apiKey'), true)
    assert.equal(isSecretSettingKey('apiKey.anthropic'), true)
    assert.equal(isSecretSettingKey('apiKey.openrouter'), true)
    // Secret keys are not renderer-writable either.
    assert.equal(isRendererWritableSettingKey('apiKey.anthropic'), false)
  })

  it('does not treat ordinary settings as secret', () => {
    assert.equal(isSecretSettingKey('model'), false)
    assert.equal(isSecretSettingKey('theme'), false)
    // Guard against prefix-style false positives.
    assert.equal(isSecretSettingKey('apiKeyboardShortcut'), false)
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
