import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAllowedRendererNavigation } from './web-contents-lockdown.ts'

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
