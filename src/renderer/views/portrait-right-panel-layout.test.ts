import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  PORTRAIT_CHROME_CLASS,
  PORTRAIT_RIGHT_PANEL_CLASS,
  mountPortraitRightPanelLayout,
  shouldUsePortraitChrome,
  shouldUsePortraitRightPanelLayout,
} from './portrait-right-panel-layout.ts'

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('portrait right panel layout', () => {
  it('uses the horizontal right panel layout only for tall portrait windows', () => {
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 640, height: 1000 },
        { autoEnabled: true, filesPaneOpen: true },
      ),
      true,
    )
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 900, height: 1000 },
        { autoEnabled: true, filesPaneOpen: true },
      ),
      false,
    )
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 640, height: 1000 },
        { autoEnabled: false, filesPaneOpen: true },
      ),
      false,
    )
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 640, height: 1000 },
        { autoEnabled: true, filesPaneOpen: false },
      ),
      false,
    )
  })

  it('lets an explicit position pin override the auto heuristic', () => {
    // `bottom` forces the horizontal layout even on a wide landscape window.
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 1600, height: 900 },
        { autoEnabled: false, filesPaneOpen: true, position: 'bottom' },
      ),
      true,
    )
    // `side` keeps the panel vertical even on a tall portrait window.
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 640, height: 1000 },
        { autoEnabled: true, filesPaneOpen: true, position: 'side' },
      ),
      false,
    )
    // A pin still respects the pane being closed.
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 1600, height: 900 },
        { autoEnabled: false, filesPaneOpen: false, position: 'bottom' },
      ),
      false,
    )
    // `auto` falls back to the viewport heuristic.
    assert.equal(
      shouldUsePortraitRightPanelLayout(
        { width: 640, height: 1000 },
        { autoEnabled: true, filesPaneOpen: true, position: 'auto' },
      ),
      true,
    )
  })

  it('uses portrait chrome on tall windows even when the right panel is closed', () => {
    assert.equal(shouldUsePortraitChrome({ width: 640, height: 1000 }, { autoEnabled: true }), true)
    assert.equal(
      shouldUsePortraitChrome({ width: 900, height: 1000 }, { autoEnabled: true }),
      false,
    )
    assert.equal(
      shouldUsePortraitChrome(
        { width: 1600, height: 900 },
        { autoEnabled: false, position: 'bottom' },
      ),
      true,
    )
    assert.equal(
      shouldUsePortraitChrome(
        { width: 640, height: 1000 },
        { autoEnabled: true, position: 'side' },
      ),
      false,
    )
  })

  it('syncs the portrait layout class from viewport, pane visibility, and settings', () => {
    const app = document.createElement('div')
    app.id = 'app'
    const body = document.createElement('div')
    app.append(body)
    document.body.append(app)
    const store = createStore({ autoPortraitRightPanel: true, filesPaneOpen: true })

    setViewport(640, 1000)
    const unmount = mountPortraitRightPanelLayout(body, store)
    assert.equal(body.classList.contains(PORTRAIT_RIGHT_PANEL_CLASS), true)
    assert.equal(body.classList.contains(PORTRAIT_CHROME_CLASS), true)
    assert.equal(app.classList.contains(PORTRAIT_CHROME_CLASS), true)

    store.setState({ autoPortraitRightPanel: false })
    store.emit('settings_changed')
    assert.equal(body.classList.contains(PORTRAIT_RIGHT_PANEL_CLASS), false)
    assert.equal(body.classList.contains(PORTRAIT_CHROME_CLASS), false)
    assert.equal(app.classList.contains(PORTRAIT_CHROME_CLASS), false)

    store.setState({ autoPortraitRightPanel: true, filesPaneOpen: false })
    store.emit('files_pane_changed')
    // Stacked grid requires the pane open; chrome stays on for tall windows so
    // the bottom panel-controls row remains available.
    assert.equal(body.classList.contains(PORTRAIT_RIGHT_PANEL_CLASS), false)
    assert.equal(body.classList.contains(PORTRAIT_CHROME_CLASS), true)
    assert.equal(app.classList.contains(PORTRAIT_CHROME_CLASS), true)

    store.setState({ filesPaneOpen: true })
    store.emit('files_pane_changed')
    assert.equal(body.classList.contains(PORTRAIT_RIGHT_PANEL_CLASS), true)

    setViewport(1200, 800)
    assert.equal(body.classList.contains(PORTRAIT_RIGHT_PANEL_CLASS), false)
    assert.equal(body.classList.contains(PORTRAIT_CHROME_CLASS), false)

    unmount()
  })
})
