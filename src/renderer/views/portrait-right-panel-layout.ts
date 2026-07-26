import type { AppStore } from '@shared/store/store.ts'
import type { RightPanelPosition } from '@shared/types/state.ts'

export const PORTRAIT_RIGHT_PANEL_CLASS = 'is-right-panel-horizontal'
/** Tall / bottom-pinned chrome: compact titlebar + labeled panel row under the footer. */
export const PORTRAIT_CHROME_CLASS = 'is-portrait-chrome'
export const PORTRAIT_RIGHT_PANEL_MIN_ASPECT_RATIO = 1.35
export const PORTRAIT_RIGHT_PANEL_MIN_HEIGHT = 700

export interface ViewportSize {
  width: number
  height: number
}

function isPortraitViewport(viewport: ViewportSize): boolean {
  if (viewport.width <= 0 || viewport.height < PORTRAIT_RIGHT_PANEL_MIN_HEIGHT) return false
  return viewport.height / viewport.width >= PORTRAIT_RIGHT_PANEL_MIN_ASPECT_RATIO
}

/**
 * Whether the window should use the portrait chrome affordances (compact
 * titlebar labels + the labeled panel-controls row under the composer). Unlike
 * the stacked panel grid, this does not require the right panel to be open —
 * users can flip modes from the bottom row without climbing to the titlebar.
 */
export function shouldUsePortraitChrome(
  viewport: ViewportSize,
  opts: { autoEnabled: boolean; position?: RightPanelPosition },
): boolean {
  if (opts.position === 'bottom') return true
  if (opts.position === 'side') return false
  if (!opts.autoEnabled) return false
  return isPortraitViewport(viewport)
}

export function shouldUsePortraitRightPanelLayout(
  viewport: ViewportSize,
  opts: { autoEnabled: boolean; filesPaneOpen: boolean; position?: RightPanelPosition },
): boolean {
  if (!opts.filesPaneOpen) return false
  // An explicit position pin wins over the auto heuristic so users can force the
  // panel below chat (e.g. a readable terminal on a small landscape screen).
  if (opts.position === 'bottom') return true
  if (opts.position === 'side') return false
  if (!opts.autoEnabled) return false
  return isPortraitViewport(viewport)
}

export function mountPortraitRightPanelLayout(body: HTMLElement, store: AppStore): () => void {
  const app = body.closest('#app') ?? document.getElementById('app')

  const sync = (): void => {
    // Pop-out windows are always landscape auxiliary panes — never stack below a
    // hidden chat column or show the portrait chrome row.
    if (document.documentElement.classList.contains('is-popout')) {
      body.classList.remove(PORTRAIT_RIGHT_PANEL_CLASS, PORTRAIT_CHROME_CLASS)
      app?.classList.remove(PORTRAIT_CHROME_CLASS)
      return
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const { autoPortraitRightPanel, filesPaneOpen, rightPanelPosition } = store.getState()
    body.classList.toggle(
      PORTRAIT_RIGHT_PANEL_CLASS,
      shouldUsePortraitRightPanelLayout(viewport, {
        autoEnabled: autoPortraitRightPanel,
        filesPaneOpen,
        position: rightPanelPosition,
      }),
    )
    const useChrome = shouldUsePortraitChrome(viewport, {
      autoEnabled: autoPortraitRightPanel,
      position: rightPanelPosition,
    })
    body.classList.toggle(PORTRAIT_CHROME_CLASS, useChrome)
    app?.classList.toggle(PORTRAIT_CHROME_CLASS, useChrome)
  }

  window.addEventListener('resize', sync, { passive: true })
  const unsubs = [store.on('files_pane_changed', sync), store.on('settings_changed', sync)]
  sync()

  return () => {
    window.removeEventListener('resize', sync)
    unsubs.forEach((unsub) => {
      unsub()
    })
    body.classList.remove(PORTRAIT_RIGHT_PANEL_CLASS, PORTRAIT_CHROME_CLASS)
    app?.classList.remove(PORTRAIT_CHROME_CLASS)
  }
}
