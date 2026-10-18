import assert from 'node:assert/strict'
import { it } from 'node:test'
import { JSDOM } from 'jsdom'
import {
  installCaptureTextPin,
  restoreCaptureTextPin,
} from '../tests/e2e/helpers/screenshot-text-pin.ts'

it('keeps independent capture pins alive across rerenders and restores only its own text', async () => {
  const dom = new JSDOM('<div id="time">Latest · now</div><div id="branch">thread-123</div>', {
    runScripts: 'outside-only',
  })
  const { window } = dom
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const install = (...args: string[]): unknown =>
    window.eval(`(${installCaptureTextPin.toString()})(...${JSON.stringify(args)})`)
  const restore = (id: string): void => {
    window.eval(`(${restoreCaptureTextPin.toString()})(${JSON.stringify(id)})`)
  }
  try {
    assert.equal(install('time', '#time', '^Latest · .+$', '', 'Latest · fixed'), 1)
    assert.equal(install('branch', '#branch', '^thread-.+$', '', 'thread-fixed'), 1)
    window.document.body.innerHTML =
      '<div id="time">Latest · later</div><div id="branch">thread-456</div>'
    await tick()
    assert.equal(window.document.querySelector('#time')?.textContent, 'Latest · fixed')
    assert.equal(window.document.querySelector('#branch')?.textContent, 'thread-fixed')
    const branchText = window.document.querySelector('#branch')?.firstChild
    assert.ok(branchText)
    branchText.textContent = 'thread-789'
    await tick()
    assert.equal(window.document.querySelector('#branch')?.textContent, 'thread-fixed')
    restore('branch')
    assert.equal(window.document.querySelector('#branch')?.textContent, 'thread-789')
    window.document.querySelector('#time')?.replaceChildren('Latest · newest')
    await tick()
    assert.equal(window.document.querySelector('#time')?.textContent, 'Latest · fixed')
    restore('time')
    assert.equal(window.document.querySelector('#time')?.textContent, 'Latest · newest')
    // Restoration is idempotent, and a failed match installs no observer.
    restore('branch')
    assert.equal(install('absent', '#missing', '.', '', 'fixed'), 0)
    assert.equal(window.e2eCaptureTextPins, undefined)
  } finally {
    window.close()
  }
})
