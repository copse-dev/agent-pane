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

  it('uses a static minus for idle (settled absence), not the pending spinner circle', () => {
    const idle = inlineStatus('idle', 'Not loaded')
    const pending = inlineStatus('pending', 'Checking…')

    assert.equal(idle.dataset['statusKind'], 'idle')
    assert.equal(idle.querySelector('.ui-icon')?.getAttribute('data-icon'), 'minus')
    assert.equal(pending.dataset['statusKind'], 'pending')
    assert.equal(pending.querySelector('.ui-icon')?.getAttribute('data-icon'), 'circle')
  })
})
