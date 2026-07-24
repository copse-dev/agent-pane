import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bindRenameBlur, RENAME_BLUR_GRACE_MS } from './rename-blur.ts'

afterEach(() => {
  document.body.replaceChildren()
})

describe('bindRenameBlur', () => {
  it('reclaims focus instead of committing during the grace window', async () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    let commits = 0
    bindRenameBlur(input, () => {
      commits += 1
    })

    // Steal focus immediately (WDIO / activating-click pattern).
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    // jsdom often skips synthetic blur-on-focus-move; dispatch once explicitly.
    if (document.activeElement !== input) {
      input.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }))
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0)
    })
    assert.equal(commits, 0, 'must not commit inside the grace window')
    assert.equal(document.activeElement, input, 'must reclaim focus during grace')

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, RENAME_BLUR_GRACE_MS + 20)
    })
    other.focus()
    if (document.activeElement !== input) {
      input.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }))
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0)
    })
    assert.equal(commits, 1, 'commits after the grace window')
  })
})
