import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import type { ModelInvalidation, ModelSettingsTarget } from '@shared/model-invalidation.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ConfirmDialogRequest } from '../views/confirm-dialog.ts'
import { commitThreadModelSelection } from './model-selection.ts'

type InvalidationApi = {
  models: Pick<ApiClient['models'], 'invalidations' | 'recoverSetting'>
  threads: Pick<ApiClient['threads'], 'recordModelSelection'>
}
interface InvalidationUi {
  warn: (request: ConfirmDialogRequest) => Promise<boolean>
  openSettings: (target: ModelSettingsTarget) => void
  isActive?: () => boolean
}

function settingsTarget(invalid: ModelInvalidation): ModelSettingsTarget {
  switch (invalid.target) {
    case 'thread':
      return 'model'
    case 'role:coder':
      return 'localDefaultModel'
    case 'role:research':
      return 'subagentModel'
    case 'role:small-tasks':
      return 'smallTasksModel'
    default:
      return invalid.target
  }
}
function acknowledgement(
  store: AppStore,
  invalid: Pick<ModelInvalidation, 'target' | 'model'>,
): string {
  const thread = getActiveThread(store)
  // Startup creates a blank chat from the saved default after settings load.
  // The default warning already covers that inherited, unedited selection.
  if (
    invalid.target === 'thread' &&
    thread?.messages.length === 0 &&
    !thread.modelSelections?.length &&
    store.getState().settings?.model === invalid.model
  )
    return JSON.stringify(['model', invalid.model])
  return JSON.stringify(
    invalid.target === 'thread'
      ? [store.getState().activeProjectId, getActiveThread(store)?.id, invalid.model]
      : [invalid.target, invalid.model],
  )
}

/** Main owns provider/auth evidence and atomic saved-field recovery. */
export async function checkProviderInvalidation(
  store: AppStore,
  api: InvalidationApi,
  ui: InvalidationUi,
  acknowledged: Set<string> = new Set(),
): Promise<string[]> {
  const thread = getActiveThread(store)
  const project = store.getState().activeProjectId
  const route =
    thread?.status === 'idle' ? (thread.model ?? store.getState().settings?.model) : undefined
  const alive = (): boolean => ui.isActive?.() ?? true
  const stillSelected = (): boolean => {
    const current = getActiveThread(store)
    return (
      alive() &&
      store.getState().activeProjectId === project &&
      current?.id === thread?.id &&
      current?.status === 'idle' &&
      (current.model ?? store.getState().settings?.model) === route
    )
  }
  const report = await api.models.invalidations(route).catch(() => null)
  if (!report?.evaluated || !alive() || (route && !stillSelected())) return []
  const invalid = report.invalidations
  const selected = new Set(report.selections.map((choice) => acknowledgement(store, choice)))
  const verified = new Set(report.verifiedChoices.map((choice) => acknowledgement(store, choice)))
  for (const key of acknowledged) {
    const parts = safeJsonParse(key, decodeWithSchema(z.array(z.string())))
    if (!parts) continue
    const evaluatedSaved = parts.length === 2
    const evaluatedThread =
      route !== undefined && parts.length === 3 && parts[0] === project && parts[1] === thread?.id
    if ((evaluatedSaved || evaluatedThread) && (!selected.has(key) || verified.has(key)))
      acknowledged.delete(key)
  }
  const pending = invalid.filter((entry) => !acknowledged.has(acknowledgement(store, entry)))
  if (!pending.length) return []
  const keys = pending.map((entry) => acknowledgement(store, entry))
  const first = pending[0]
  if (!first) return []
  const hasFallback = pending.some((entry) => entry.fallback)
  const open = await ui.warn({
    message: 'Model settings need attention',
    detail: pending
      .map(
        (entry) =>
          `${entry.label}: ${entry.model}. ${entry.reason} ${
            entry.fallback
              ? `Dismiss to use ${entry.fallback.replace(/^lmstudio:/, '')} on this device.`
              : 'No suitable on-device model is available; this choice will be preserved.'
          }`,
      )
      .join('\n\n'),
    confirmLabel: 'Open Settings',
    cancelLabel: hasFallback ? 'Use local models' : 'Dismiss',
  })
  if (!alive()) return keys
  if (open) {
    if (first.target !== 'thread' || stillSelected()) ui.openSettings(settingsTarget(first))
    return keys
  }
  for (const entry of pending) {
    if (!alive() || !entry.fallback) continue
    if (entry.target === 'thread') {
      if (!thread || !stillSelected()) continue
      const latest = await api.models.invalidations(route, true).catch(() => null)
      if (
        !stillSelected() ||
        !latest?.invalidations.some(
          (item) =>
            item.target === 'thread' && item.model === route && item.fallback === entry.fallback,
        )
      )
        continue
      commitThreadModelSelection(store, api, thread.id, 'auto', route, entry.fallback)
    } else {
      const replaced = await api.models
        .recoverSetting(entry.target, entry.model, entry.fallback)
        .catch(() => false)
      if (!replaced || !alive()) continue
      if (entry.target === 'model' && store.getState().settings?.model === entry.model) {
        store.setState({ settings: { ...store.getState().settings, model: entry.fallback } })
      }
      store.emit('settings_changed')
    }
  }
  return keys
}

/** Main-window ownership, coalesced rechecks and per-value acknowledgement. */
export function attachProviderInvalidationWarning(
  store: AppStore,
  api: InvalidationApi,
  ui: InvalidationUi,
): () => void {
  const acknowledged = new Set<string>()
  let checking = false
  let pending = false
  let disposed = false
  const check = (): void => {
    if (disposed) return
    if (checking) {
      pending = true
      return
    }
    checking = true
    void checkProviderInvalidation(store, api, { ...ui, isActive: () => !disposed }, acknowledged)
      .then((keys) => {
        keys.forEach((key) => acknowledged.add(key))
      })
      .catch((error: unknown) => {
        console.error('[models] could not check provider configuration', error)
      })
      .finally(() => {
        checking = false
        if (pending) {
          pending = false
          check()
        }
      })
  }
  const unsubscribe = [
    store.on('workspace_changed', check),
    store.on('threads_changed', check),
    store.on('settings_changed', check),
    store.on('thread_status_changed', check),
  ]
  check()
  return () => {
    disposed = true
    unsubscribe.forEach((stop) => {
      stop()
    })
  }
}
