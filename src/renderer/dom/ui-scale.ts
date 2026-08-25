import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { DEFAULT_UI_SCALE, clampUiScale, normalizeUiScale, stepUiScale } from '@shared/ui-scale.ts'

/** Push the interface scale onto `:root` so every token that multiplies it updates. */
export function applyUiScale(scale: number): void {
  document.documentElement.style.setProperty('--ui-scale', String(clampUiScale(scale)))
}

/**
 * Clamp, apply, persist, and broadcast a new interface scale.
 * Callers that only want a CSS preview can use `applyUiScale`.
 */
export async function commitUiScale(
  store: AppStore,
  api: Pick<ApiClient, 'settings'>,
  next: number,
): Promise<number> {
  const uiScale = clampUiScale(next)
  applyUiScale(uiScale)
  store.setState({ uiScale })
  store.emit('settings_changed')
  await api.settings.set('uiScale', uiScale)
  return uiScale
}

export async function bumpUiScale(
  store: AppStore,
  api: Pick<ApiClient, 'settings'>,
  direction: 1 | -1,
): Promise<number> {
  return commitUiScale(store, api, stepUiScale(store.getState().uiScale, direction))
}

export async function resetUiScale(
  store: AppStore,
  api: Pick<ApiClient, 'settings'>,
): Promise<number> {
  return commitUiScale(store, api, DEFAULT_UI_SCALE)
}

/** Restore a persisted (or default) scale at boot before the layout paints. */
export function restoreUiScale(saved: unknown): number {
  const uiScale = normalizeUiScale(saved)
  applyUiScale(uiScale)
  return uiScale
}
