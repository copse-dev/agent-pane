import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  hardenWebviewPreferences,
  isAllowedRendererNavigation,
  isExternalHttpUrl,
} from './web-contents-lockdown.ts'

describe('isAllowedRendererNavigation', () => {
  it('allows about:blank and renderer file URLs', () => {
    assert.equal(isAllowedRendererNavigation('about:blank'), true)
    const index = pathToFileURL(join(__dirname, '../renderer/index.html')).href
    assert.equal(isAllowedRendererNavigation(index), true)
  })

  it('blocks http(s) and file URLs outside the renderer tree', () => {
    assert.equal(isAllowedRendererNavigation('https://evil.example/'), false)
    assert.equal(isAllowedRendererNavigation('http://localhost:3000/'), false)
    const outside = pathToFileURL('/etc/passwd').href
    assert.equal(isAllowedRendererNavigation(outside), false)
  })
})

describe('hardenWebviewPreferences', () => {
  it('forces secure preferences regardless of what the renderer requested', () => {
    const prefs: Electron.WebPreferences = {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      preload: '/tmp/evil-preload.js',
    }
    hardenWebviewPreferences(prefs)
    assert.equal(prefs.nodeIntegration, false)
    assert.equal(prefs.nodeIntegrationInSubFrames, false)
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.sandbox, true)
    assert.equal(prefs.webSecurity, true)
    assert.equal(prefs.preload, undefined)
  })
})

describe('isExternalHttpUrl', () => {
  it('matches http and https only', () => {
    assert.equal(isExternalHttpUrl('https://github.com/org/repo/pull/1'), true)
    assert.equal(isExternalHttpUrl('http://localhost:3000/'), true)
    assert.equal(isExternalHttpUrl('javascript:alert(1)'), false)
    assert.equal(isExternalHttpUrl('file:///etc/passwd'), false)
  })
})
