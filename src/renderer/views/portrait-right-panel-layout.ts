import type { AppStore } from '@shared/store/store.ts'

export const PORTRAIT_RIGHT_PANEL_CLASS = 'is-right-panel-horizontal'
export const PORTRAIT_RIGHT_PANEL_MIN_ASPECT_RATIO = 1.35
export const PORTRAIT_RIGHT_PANEL_MIN_HEIGHT = 700

export interface ViewportSize {
  width: number
  height: number
}

export function shouldUsePortraitRightPanelLayout(
  viewport: ViewportSize,
  opts: { autoEnabled: boolean; filesPaneOpen: boolean },
): boolean {
  if (!opts.autoEnabled || !opts.filesPaneOpen) return false
  if (viewport.width <= 0 || viewport.height < PORTRAIT_RIGHT_PANEL_MIN_HEIGHT) return false
  return viewport.height / viewport.width >= PORTRAIT_RIGHT_PANEL_MIN_ASPECT_RATIO
}

export function mountPortraitRightPanelLayout(body: HTMLElement, store: AppStore): () => void {
  const sync = (): void => {
    body.classList.toggle(
      PORTRAIT_RIGHT_PANEL_CLASS,
      shouldUsePortraitRightPanelLayout(
        { width: window.innerWidth, height: window.innerHeight },
        {
          autoEnabled: store.getState().autoPortraitRightPanel,
          filesPaneOpen: store.getState().filesPaneOpen,
        },
      ),
    )
  }

  window.addEventListener('resize', sync, { passive: true })
  const unsubs = [store.on('files_pane_changed', sync), store.on('settings_changed', sync)]
  sync()

  return () => {
    window.removeEventListener('resize', sync)
    unsubs.forEach((unsub) => {
      unsub()
    })
    body.classList.remove(PORTRAIT_RIGHT_PANEL_CLASS)
  }
}
