import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowCloseEndsShells } from './terminal.ts'

test("a close that goes through ends the window's shells", () => {
  assert.equal(windowCloseEndsShells({ prevented: false, rendererUnloaded: false }), true)
})

// The close guard cancels `close` to ask about a running agent; answering "keep
// working" leaves the window, and its Shells tabs, open.
test('a cancelled close leaves the shells of a window that stays open running', () => {
  assert.equal(windowCloseEndsShells({ prevented: true, rendererUnloaded: false }), false)
})

test('a close turned into a detach ends the shells only when the page was unloaded', () => {
  assert.equal(windowCloseEndsShells({ prevented: true, rendererUnloaded: true }), true)
})
