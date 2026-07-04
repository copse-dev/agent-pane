import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inlineStatus, setInlineStatus } from './inline-status.ts'

describe('inlineStatus', () => {
  it('renders the requested icon and text', () => {
    const status = inlineStatus('warn', 'not trusted')

    assert.equal(status.dataset['statusKind'], 'warn')
    assert.equal(status.textContent, 'not trusted')
    assert.equal(status.querySelector('.ui-icon')?.getAttribute('data-icon'), 'triangle-alert')
  })

  it('replaces an element with inline status content', () => {
    const host = document.createElement('span')
    host.textContent = 'old'

    setInlineStatus(host, 'filled', 'connected')

    assert.equal(host.textContent, 'connected')
    assert.equal(host.querySelector('.ui-icon')?.getAttribute('data-icon'), 'dot')
  })
})
