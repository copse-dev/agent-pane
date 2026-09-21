import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldShowNativeWindows } from './native-window-visibility.ts'

function commandLineWith(...switches: string[]): { hasSwitch(name: string): boolean } {
  return { hasSwitch: (name) => switches.includes(name) }
}

describe('shouldShowNativeWindows', () => {
  it('shows windows during an ordinary desktop run', () => {
    assert.equal(shouldShowNativeWindows(commandLineWith()), true)
  })

  it('keeps BrowserWindows hidden when Chromium owns a headless session', () => {
    assert.equal(shouldShowNativeWindows(commandLineWith('headless')), false)
  })
})
