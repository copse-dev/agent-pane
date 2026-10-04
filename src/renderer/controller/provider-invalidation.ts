import { extraProviderSlugFromModel } from '@copse/llm/extra-providers.ts'
import { getLocalModelCapability } from '@copse/llm/local-model-catalog.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ConfirmDialogRequest } from '../views/confirm-dialog.ts'
import { commitThreadModelSelection } from './model-selection.ts'

type InvalidationApi = {
  settings: Pick<ApiClient['settings'], 'extraProviders'>
  lmStudio: Pick<ApiClient['lmStudio'], 'modelInfo'>
  threads: Pick<ApiClient['threads'], 'recordModelSelection'>
}

interface InvalidationUi {
  warn: (request: ConfirmDialogRequest) => Promise<boolean>
  openSettings: () => void
  isActive?: () => boolean
}

/** Only a missing effective provider is conclusive; a failed probe is not. */
export async function checkProviderInvalidation(
  store: AppStore,
  api: InvalidationApi,
  ui: InvalidationUi,
): Promise<string | null> {
  const thread = getActiveThread(store)
  if (!thread || thread.status !== 'idle') return null
  const route = thread.model ?? store.getState().settings?.model
  if (typeof route !== 'string') return null
  const slug = extraProviderSlugFromModel(route)
  if (!slug) return null

  let missing: boolean
  try {
    missing = !(await api.settings.extraProviders()).some((provider) => provider.id === slug)
  } catch {
    return null
  }
  if (!missing) return null

  function stillSelected(): boolean {
    const current = getActiveThread(store)
    return (
      (ui.isActive?.() ?? true) &&
      current?.id === thread?.id &&
      current?.status === 'idle' &&
      (current.model ?? store.getState().settings?.model) === route
    )
  }
  if (!stillSelected()) return null
  const models = await api.lmStudio.modelInfo().catch(() => [])
  const local = models.find(
    (model) =>
      model.local === true &&
      model.embedding !== true &&
      getLocalModelCapability(model.id)?.bestForRoles.includes('coder'),
  )
  if (!stillSelected()) return null
  const openSettings = await ui.warn({
    message: 'Your selected model provider was removed',
    detail: `${route} is no longer configured. ${
      local
        ? `Dismiss to use ${local.id} on this device, or open Settings to choose another provider.`
        : 'Open Settings to configure a provider or choose another model. No suitable local coding model is available.'
    }`,
    confirmLabel: 'Open Settings',
    cancelLabel: local ? 'Use local model' : 'Dismiss',
  })
  if (openSettings) {
    if (stillSelected()) ui.openSettings()
    return route
  }
  if (!local || !stillSelected()) return route

  // Revalidate after the dialog: the provider or local server may have changed
  // while the user considered the warning. Never substitute another cloud route.
  try {
    const [providers, latestModels] = await Promise.all([
      api.settings.extraProviders(),
      api.lmStudio.modelInfo(),
    ])
    if (
      providers.some((provider) => provider.id === slug) ||
      !latestModels.some(
        (model) => model.id === local.id && model.local === true && model.embedding !== true,
      ) ||
      !stillSelected()
    )
      return route
  } catch {
    return route
  }
  commitThreadModelSelection(store, api, thread.id, 'auto', route, `lmstudio:${local.id}`)
  return route
}

/** Main-window ownership prevents duplicate prompts from detached panes. */
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
    const thread = getActiveThread(store)
    const route = thread?.model ?? store.getState().settings?.model
    if (disposed || typeof route !== 'string') return
    if (checking) {
      pending = true
      return
    }
    const key = JSON.stringify([store.getState().activeProjectId, thread?.id, route])
    if (acknowledged.has(key)) return
    checking = true
    void checkProviderInvalidation(store, api, { ...ui, isActive: () => !disposed })
      .then((invalid) => {
        if (invalid) acknowledged.add(key)
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
    store.on('settings_changed', () => {
      acknowledged.clear()
      check()
    }),
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
