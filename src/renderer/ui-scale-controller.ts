import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../preload/api.d.ts'
import { clampUiScale, DEFAULT_UI_SCALE, stepUiScale, uiScaleLabel } from '@shared/ui-scale.ts'
import { applyUiScale } from './dom/ui-scale.ts'
import { isTypingTarget } from './keyboard-shortcuts.ts'

function isMonacoSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.monaco-editor') !== null
}

function isLocalZoomOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('.mermaid-expand-dialog') !== null ||
      target.closest('.image-expand-dialog') !== null)
  )
}

function matchUiScaleKeyboard(e: KeyboardEvent): 'in' | 'out' | 'reset' | null {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey) return null
  if (e.key === '0' && !e.shiftKey) return 'reset'
  if (e.shiftKey) return null
  if (e.key === '=' || e.key === '+') return 'in'
  if (e.key === '-' || e.key === '_') return 'out'
  return null
}

/**
 * Whole-interface scale: CSS token multiplier plus editor/terminal font sync via
 * `settings_changed`. Replaces Chromium page zoom (disabled / ineffective for
 * `file://` shells) with crisp token scaling.
 */
export function registerUiScaleController(store: AppStore, api: ApiClient): void {
  async function setUiScale(next: number, { persist }: { persist: boolean }): Promise<void> {
    const clamped = clampUiScale(next)
    if (clamped === store.getState().uiScale) return
    applyUiScale(clamped)
    store.setState({ uiScale: clamped })
    if (persist) await api.settings.set('uiScale', clamped)
    store.emit('settings_changed')
  }

  function adjust(direction: 'in' | 'out' | 'reset'): void {
    void setUiScale(stepUiScale(store.getState().uiScale, direction), { persist: true })
  }

  document.addEventListener('keydown', (e) => {
    const action = matchUiScaleKeyboard(e)
    if (!action) return
    if (isTypingTarget(e.target) && action !== 'reset') return
    e.preventDefault()
    adjust(action)
  })

  document.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return
      if (isMonacoSurface(e.target) || isLocalZoomOverlay(e.target)) return
      e.preventDefault()
      adjust(e.deltaY < 0 ? 'in' : 'out')
    },
    { passive: false },
  )

  api.menu.onZoomIn(() => {
    adjust('in')
  })
  api.menu.onZoomOut(() => {
    adjust('out')
  })
  api.menu.onResetZoom(() => {
    adjust('reset')
  })

  // Dev-only live label in the title bar area when scale != 100% (spike aid).
  const badge = document.createElement('div')
  badge.className = 'ui-scale-badge'
  badge.hidden = true
  badge.setAttribute('aria-live', 'polite')
  document.getElementById('titlebar')?.append(badge)

  const syncBadge = (): void => {
    const scale = store.getState().uiScale
    const show = scale !== DEFAULT_UI_SCALE
    badge.hidden = !show
    badge.textContent = show ? uiScaleLabel(scale) : ''
  }

  store.on('settings_changed', syncBadge)
  syncBadge()
}

export function loadInitialUiScale(saved: unknown): number {
  const scale = typeof saved === 'number' && Number.isFinite(saved) ? saved : DEFAULT_UI_SCALE
  applyUiScale(scale)
  return clampUiScale(scale)
}
