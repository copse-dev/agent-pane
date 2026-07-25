import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ownsScreenshot,
  screenshotName,
  unscoped,
  type ScreenshotScope,
} from './screenshot-scope.mts'

function scope(affected: string[], branchOwned: string[] = []): ScreenshotScope {
  return { enabled: true, affected: new Set(affected), branchOwned: new Set(branchOwned) }
}

describe('screenshotName', () => {
  it('reduces a repo-relative path to its basename', () => {
    assert.equal(screenshotName('tests/e2e/screenshots/settings-packs.png'), 'settings-packs.png')
  })

  it('passes a bare basename through', () => {
    assert.equal(screenshotName('settings-packs.png'), 'settings-packs.png')
  })
})

describe('ownsScreenshot', () => {
  it('owns a shot the oracle maps to this diff', () => {
    const s = scope(['settings-packs.png'])
    assert.equal(ownsScreenshot(s, 'tests/e2e/screenshots/settings-packs.png'), true)
  })

  it('disowns a shot no selected spec renders', () => {
    // The release-smoke case: a main-process fix re-renders Settings shots it
    // cannot have moved a pixel of.
    const s = scope(['settings-packs.png'])
    assert.equal(ownsScreenshot(s, 'tests/e2e/screenshots/portrait-panel-controls.png'), false)
  })

  it('owns a shot hand-committed on the branch even when unmapped', () => {
    // A deliberately committed reference shot is the author's work whatever the
    // oracle's selector map thinks.
    const s = scope([], ['portrait-panel-controls.png'])
    assert.equal(ownsScreenshot(s, 'tests/e2e/screenshots/portrait-panel-controls.png'), true)
  })

  it('owns everything when scope is disabled', () => {
    // No merge-base (local run / shallow clone) degrades to the pre-scope policy
    // rather than holding every shot.
    assert.equal(ownsScreenshot(unscoped(), 'tests/e2e/screenshots/anything.png'), true)
  })

  it('disowns everything for a diff that maps to no shots at all', () => {
    // A lockfile or benchmark-only PR: `computeScreenshotGate` filters to
    // render-affecting files first, so `affected` is empty and nothing commits.
    assert.equal(ownsScreenshot(scope([]), 'tests/e2e/screenshots/settings-packs.png'), false)
  })
})
