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
    assert.equal(isRendererWritableSettingKey('safetyExternalDenyThreshold'), false)
    assert.equal(isRendererWritableSettingKey('mcpAutoAllowReadOnly'), false)
    assert.equal(isRendererWritableSettingKey('defaultReadonlyMode'), false)
  })

  it('allows benign UI keys', () => {
    assert.equal(isRendererWritableSettingKey('model'), true)
    assert.equal(isRendererWritableSettingKey('appIconVariant'), true)
    assert.equal(isRendererWritableSettingKey('autoPortraitRightPanel'), true)
    assert.equal(parseRendererWritableSetting('theme', 'dark'), 'dark')
    assert.equal(parseRendererWritableSetting('appIconVariant', 'aurora'), 'aurora')
    assert.equal(parseRendererWritableSetting('autoPortraitRightPanel', false), false)
  })

  it('accepts a non-negative integer post-turn-review diff threshold, rejects negatives', () => {
    assert.equal(isRendererWritableSettingKey('postTurnReviewMinChangedLines'), true)
    assert.equal(parseRendererWritableSetting('postTurnReviewMinChangedLines', 0), 0)
    assert.equal(parseRendererWritableSetting('postTurnReviewMinChangedLines', 15), 15)
    assert.throws(() => parseRendererWritableSetting('postTurnReviewMinChangedLines', -1))
  })

  it('parses security settings bundle', () => {
    const parsed = securitySettingsSchema.parse({
      localServerUrl: 'http://127.0.0.1:1234/v1',
      safetyClassifierEnabled: true,
      safetyExternalDenyThreshold: 1,
      safetyModel: '',
      autoRunSandboxCommands: false,
      mcpAutoAllowReadOnly: true,
      cursorHooksEnabled: false,
      defaultReadonlyMode: true,
      webAllowedOrigins: ['https://duckduckgo.com', 'http://localhost:*'],
      webAllowUserApproval: true,
    })
    assert.equal(parsed.localServerUrl, 'http://127.0.0.1:1234/v1')
    assert.equal(parsed.safetyExternalDenyThreshold, 1)
    assert.deepEqual(parsed.webAllowedOrigins, ['https://duckduckgo.com', 'http://localhost:*'])
  })

  it('parses the renderer bundle without cursorHooksEnabled (storage-only, no UI yet)', () => {
    const parsed = securitySettingsSchema.parse({
      localServerUrl: 'http://127.0.0.1:1234/v1',
      safetyClassifierEnabled: true,
      safetyExternalDenyThreshold: 1,
      safetyModel: '',
      autoRunSandboxCommands: false,
      mcpAutoAllowReadOnly: true,
      defaultReadonlyMode: false,
      webAllowedOrigins: ['https://duckduckgo.com'],
      webAllowUserApproval: true,
    })
    assert.equal(parsed.cursorHooksEnabled, undefined)
    assert.equal('cursorHooksEnabled' in parsed, false)
  })

  it('strips unknown deprecated threshold keys from the security bundle', () => {
    const parsed = securitySettingsSchema.parse({
      localServerUrl: 'http://127.0.0.1:1234/v1',
      safetyClassifierEnabled: true,
      safetySandboxAllowThreshold: 0.85,
      safetyConfidenceThreshold: 0.85,
      safetyExternalDenyThreshold: 1,
      safetyModel: '',
      autoRunSandboxCommands: false,
      mcpAutoAllowReadOnly: true,
      defaultReadonlyMode: false,
      webAllowedOrigins: ['https://duckduckgo.com'],
      webAllowUserApproval: true,
    })
    assert.equal('safetySandboxAllowThreshold' in parsed, false)
    assert.equal('safetyConfidenceThreshold' in parsed, false)
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

  it('accepts safe remoteAgentBaseUrl values', () => {
    assert.equal(
      parseRendererWritableSetting('remoteAgentBaseUrl', ''),
      '',
      'empty string means use the provider default',
    )
    for (const value of [
      'https://api.cursor.com',
      'https://example.com',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
    ]) {
      assert.equal(
        typeof parseRendererWritableSetting('remoteAgentBaseUrl', value),
        'string',
        `expected ${value} to be accepted`,
      )
    }
  })

  it('rejects unsafe remoteAgentBaseUrl values', () => {
    for (const value of [
      'http://evil.example',
      'https://user:pass@evil.example',
      'ftp://x',
      'not a url',
    ]) {
      assert.throws(
        () => parseRendererWritableSetting('remoteAgentBaseUrl', value),
        `expected ${value} to be rejected`,
      )
    }
  })

  it('rejects malformed web origins in the security bundle', () => {
    assert.throws(() =>
      securitySettingsSchema.parse({
        localServerUrl: '',
        safetyClassifierEnabled: true,
        safetyExternalDenyThreshold: 1,
        safetyModel: '',
        autoRunSandboxCommands: true,
        mcpAutoAllowReadOnly: false,
        cursorHooksEnabled: false,
        defaultReadonlyMode: false,
        webAllowedOrigins: ['https://example.com/path'],
        webAllowUserApproval: true,
      }),
    )
  })
})
