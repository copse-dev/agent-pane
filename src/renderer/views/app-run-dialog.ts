import type { AppStore } from '@shared/store/store.ts'
import {
  APP_RUN_STAGE_LABELS,
  type AppRunAction,
  type AppRunDiscovery,
  type AppRunOperation,
  type AppRunOwner,
  type AppRunPlatform,
  type AppRunSelection,
  type AppRunSetupOptions,
} from '@shared/types/app-run.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { closeIcon, playIcon, refreshIcon } from '../dom/icons.ts'
import { createOverlayDialog } from './dialog-shell.ts'

const isBusy = (operation: AppRunOperation): boolean =>
  !['running', 'succeeded', 'failed', 'cancelled', 'stopped'].includes(operation.stage)

export function createAppRunPanel(
  api: ApiClient,
  owner: AppRunOwner,
  onLaunched: () => void = () => {},
): { element: HTMLElement; dispose: () => void } {
  const element = el('div', { class: 'app-run-panel' })
  const notice = el('p', { class: 'app-run-notice', role: 'status' }, 'Loading app configuration…')
  const fields = el('div', { class: 'app-run-fields' })
  const appSelect = el('select', { 'aria-label': 'App', class: 'app-run-app' })
  const deviceSelect = el('select', { 'aria-label': 'Device', class: 'app-run-device' })
  const variantSelect = el('select', {
    'aria-label': 'Build variant or scheme',
    class: 'app-run-variant',
  })
  const configuration = el(
    'select',
    { 'aria-label': 'Configuration' },
    el('option', { value: 'Debug' }, 'Debug'),
    el('option', { value: 'Release' }, 'Release'),
  )
  const signing = el('input', { type: 'checkbox', class: 'app-run-signing' })
  const signingLabel = el(
    'label',
    { class: 'app-run-check' },
    signing,
    'Allow signing profile updates for this run',
  )
  const configurationLabel = el('label', {}, 'Configuration', configuration)
  const variantLabel = el('label', {}, el('span', {}, 'Build variant / scheme'), variantSelect)
  const more = el(
    'details',
    { class: 'app-run-more' },
    el('summary', {}, 'More options'),
    variantLabel,
    configurationLabel,
    signingLabel,
  )
  const appLabel = el('label', {}, 'App', appSelect)
  const deviceLabel = el('label', {}, 'Device', deviceSelect)
  fields.append(appLabel, deviceLabel, more)
  const issues = el('div', { class: 'app-run-issues' })
  const setupHost = el('div', { class: 'app-run-setup', hidden: true })
  const create = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost app-run-create' },
    'Create a device…',
  )
  const refresh = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost app-run-refresh',
      'aria-label': 'Refresh app targets',
    },
    refreshIcon(),
  )
  const run = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary app-run-run' },
    playIcon(),
    'Run',
  )
  const build = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost app-run-build' },
    'Build',
  )
  const test = el('button', { type: 'button', class: 'ui-btn ui-btn-ghost app-run-test' }, 'Test')
  const actions = el(
    'div',
    { class: 'app-run-actions' },
    run,
    build,
    test,
    el('span', { class: 'app-run-spacer' }),
    create,
    refresh,
  )
  const status = el('div', { class: 'app-run-operation', hidden: true, 'aria-live': 'polite' })
  const statusTitle = el('strong', { class: 'app-run-stage' })
  const elapsed = el('span', { class: 'app-run-elapsed' })
  const cancel = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost app-run-cancel' },
    'Cancel',
  )
  const stop = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost app-run-stop' },
    'Stop app',
  )
  const error = el('p', { class: 'app-run-error', role: 'alert', hidden: true })
  const log = el('pre', { class: 'app-run-log' })
  const logs = el('details', { class: 'app-run-logs' }, el('summary', {}, 'View logs'), log)
  status.append(
    el(
      'div',
      { class: 'app-run-actions' },
      statusTitle,
      elapsed,
      el('span', { class: 'app-run-spacer' }),
      cancel,
      stop,
    ),
    error,
    logs,
  )
  element.append(notice, fields, issues, setupHost, actions, status)
  let disposed = false,
    loading = false,
    deviceGeneration = 0,
    setupGeneration = 0
  let discovery: AppRunDiscovery = { apps: [], devices: [], issues: [], preferred: null }
  let operation: AppRunOperation | undefined
  let startedHere: string | null = null
  let refreshedSetup: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const currentApp = (): AppRunDiscovery['apps'][number] | undefined =>
    discovery.apps.find((app) => app.id === appSelect.value)
  function fail(value: unknown): void {
    notice.textContent = value instanceof Error ? value.message : String(value)
    notice.hidden = false
    notice.dataset['kind'] = 'error'
  }
  function updateEnabled(): void {
    const busy = loading || (operation !== undefined && isBusy(operation))
    run.disabled = busy || !currentApp() || !variantSelect.value || !deviceSelect.value
    build.disabled =
      busy ||
      !currentApp() ||
      !variantSelect.value ||
      (currentApp()?.platform === 'apple' && !deviceSelect.value)
    test.disabled = build.disabled
    for (const control of [
      appSelect,
      deviceSelect,
      variantSelect,
      configuration,
      signing,
      create,
      refresh,
    ])
      control.disabled = busy
  }
  function selection(): AppRunSelection {
    return {
      appId: appSelect.value,
      deviceId: deviceSelect.value,
      variant: variantSelect.value,
      configuration: configuration.value,
      provisioningUpdates: signing.checked,
    }
  }
  async function loadDevices(preferred?: string): Promise<void> {
    const app = currentApp()
    const generation = ++deviceGeneration
    if (!app) return
    loading = true
    notice.hidden = false
    notice.textContent = 'Finding compatible devices…'
    updateEnabled()
    try {
      const devices = await api.appRun.devices(owner, app.id, variantSelect.value)
      if (disposed || generation !== deviceGeneration) return
      deviceSelect.replaceChildren(
        ...devices.map((device) =>
          el(
            'option',
            { value: device.id, disabled: device.state === 'unavailable' },
            `${device.name} · ${device.runtime}${device.state === 'stopped' ? ' · Stopped' : ''}${device.detail ? ` · ${device.detail}` : ''}`,
          ),
        ),
      )
      if (preferred && devices.some((d) => d.id === preferred && d.state !== 'unavailable'))
        deviceSelect.value = preferred
      else
        deviceSelect.value =
          devices.find((d) => d.state === 'running')?.id ??
          devices.find((d) => d.state !== 'unavailable')?.id ??
          ''
      notice.textContent = devices.length
        ? 'No compatible device is available. Create a device with a supported runtime.'
        : 'Create a device to run this app.'
      notice.hidden = devices.some((device) => device.state !== 'unavailable')
    } catch (value) {
      if (generation === deviceGeneration) fail(value)
    } finally {
      if (generation === deviceGeneration) {
        loading = false
        updateEnabled()
      }
    }
  }
  async function selectApp(preferred?: AppRunSelection | null): Promise<void> {
    const app = currentApp()
    if (!app) return
    variantSelect.replaceChildren(
      ...app.variants.map((variant) => el('option', { value: variant }, variant)),
    )
    variantSelect.value =
      preferred?.appId === app.id && app.variants.includes(preferred.variant)
        ? preferred.variant
        : (app.variants[0] ?? '')
    configuration.value = preferred?.configuration ?? 'Debug'
    signing.checked = false
    configurationLabel.hidden = app.platform !== 'apple'
    signingLabel.hidden = app.platform !== 'apple'
    variantLabel.firstElementChild?.replaceChildren(
      app.platform === 'apple' ? 'Scheme' : 'Build variant',
    )
    await loadDevices(preferred?.deviceId)
  }
  async function discover(): Promise<void> {
    loading = true
    notice.hidden = false
    notice.dataset['kind'] = 'working'
    notice.textContent = 'Loading app configuration…'
    updateEnabled()
    const previous = appSelect.value ? selection() : null
    try {
      const result = await api.appRun.discover(owner)
      if (disposed) return
      discovery = result
      appSelect.replaceChildren(
        ...result.apps.map((app) =>
          el(
            'option',
            { value: app.id },
            `${app.name} · ${app.platform === 'apple' ? 'Apple' : 'Android'}${result.apps.length > 1 ? ` — ${app.location}` : ''}`,
          ),
        ),
      )
      const preferred =
        previous && result.apps.some((a) => a.id === previous.appId) ? previous : result.preferred
      appSelect.value = preferred?.appId ?? result.apps[0]?.id ?? ''
      issues.replaceChildren(
        ...result.issues.map((issue) => {
          const action = el('button', { type: 'button', class: 'ui-btn ui-btn-ghost' }, issue.label)
          action.addEventListener('click', () => {
            void api.appRun
              .setup(owner, { platform: issue.platform, action: issue.action })
              .catch(fail)
          })
          return el('div', { class: 'app-run-issue' }, el('p', {}, issue.message), action)
        }),
      )
      fields.hidden = !result.apps.length
      notice.hidden = result.apps.length > 0 || result.issues.length > 0
      notice.textContent = result.apps.length
        ? ''
        : 'No supported apps found. Add an Xcode project or an Android project with a Gradle wrapper.'
      if (result.apps.length) await selectApp(preferred)
    } catch (value) {
      if (!disposed) fail(value)
    } finally {
      loading = false
      updateEnabled()
    }
  }
  function renderOperation(): void {
    status.hidden = !operation
    if (!operation) return
    statusTitle.textContent = APP_RUN_STAGE_LABELS[operation.stage]
    status.dataset['stage'] = operation.stage
    const end = isBusy(operation) ? Date.now() : operation.updatedAt
    elapsed.textContent = `${String(Math.max(0, Math.round((end - operation.createdAt) / 1000)))}s`
    log.textContent = operation.logs || 'Waiting for output…'
    error.textContent = operation.error ?? ''
    error.hidden = !operation.error
    cancel.hidden = !isBusy(operation)
    stop.hidden = operation.stage !== 'running' || !operation.appSessionId
    updateEnabled()
    if (operation.stage === 'running' && operation.id === startedHere) {
      startedHere = null
      onLaunched()
    }
  }
  async function poll(): Promise<void> {
    try {
      const list = await api.appRun.operations(owner)
      if (disposed) return
      operation = list[0]
      renderOperation()
      if (
        operation?.action === 'setup' &&
        operation.stage === 'succeeded' &&
        refreshedSetup !== operation.id
      ) {
        refreshedSetup = operation.id
        void discover()
      }
    } catch (value) {
      if (!disposed) fail(value)
    }
    if (!disposed)
      timer = setTimeout(() => {
        void poll()
      }, 750)
  }
  async function execute(action: AppRunAction): Promise<void> {
    loading = true
    notice.hidden = true
    updateEnabled()
    try {
      operation = await api.appRun.execute(owner, selection(), action)
      if (action === 'run') startedHere = operation.id
      signing.checked = false
      renderOperation()
    } catch (value) {
      fail(value)
    } finally {
      loading = false
      updateEnabled()
    }
  }
  async function showSetup(platform: AppRunPlatform): Promise<void> {
    const generation = ++setupGeneration
    setupHost.hidden = false
    setupHost.replaceChildren(el('p', {}, 'Loading device setup…'))
    let options: AppRunSetupOptions
    try {
      options = await api.appRun.setupOptions(owner, platform)
    } catch (value) {
      setupHost.replaceChildren(el('p', {}, value instanceof Error ? value.message : String(value)))
      return
    }
    if (disposed || generation !== setupGeneration) return
    const runtime = el(
      'select',
      { 'aria-label': 'Device runtime' },
      ...options.runtimes.map((r) =>
        el(
          'option',
          { value: r.id },
          `${r.name}${r.installed ? ' · Installed' : ' · Download required'}`,
        ),
      ),
    )
    const deviceType = el(
      'select',
      { 'aria-label': 'Device type' },
      ...options.deviceTypes.map((d) => el('option', { value: d.id }, d.name)),
    )
    const name = el('input', {
      'aria-label': 'Device name',
      value: 'Development phone',
      maxlength: '80',
    })
    const explanation = el('p', { class: 'app-run-notice' })
    const apply = el('button', {
      type: 'button',
      class: 'ui-btn ui-btn-primary app-run-setup-apply',
    })
    const dismiss = el('button', { type: 'button', class: 'ui-btn ui-btn-ghost' }, 'Close setup')
    const installApple = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-ghost', hidden: platform !== 'apple' },
      'Download iOS runtime…',
    )
    const sync = (): void => {
      const selected = options.runtimes.find((r) => r.id === runtime.value)
      const download = selected && !selected.installed
      apply.textContent = download ? 'Download selected image' : 'Create device'
      explanation.textContent = download
        ? 'Downloads this system image into your Android SDK. Review any license agreement in Android Studio before continuing.'
        : 'Uses an installed runtime. Your existing devices are kept.'
      apply.disabled = !selected || (!download && (!name.value.trim() || !deviceType.value))
    }
    runtime.addEventListener('change', sync)
    name.addEventListener('input', sync)
    dismiss.addEventListener('click', () => {
      setupHost.hidden = true
    })
    apply.addEventListener('click', () => {
      apply.disabled = true
      const selected = options.runtimes.find((r) => r.id === runtime.value)
      void api.appRun
        .setup(owner, {
          platform,
          action: selected?.installed ? 'create-device' : 'install-android-image',
          runtimeId: runtime.value,
          deviceTypeId: deviceType.value,
          name: name.value,
        })
        .then((result) => {
          operation = result ?? undefined
          setupHost.hidden = true
          renderOperation()
        })
        .catch(fail)
        .finally(sync)
    })
    installApple.addEventListener('click', () => {
      explanation.textContent =
        'Downloads the iOS runtime through Xcode. This can be a large download and take several minutes.'
      const confirm = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-primary' },
        'Download iOS runtime',
      )
      confirm.addEventListener('click', () => {
        confirm.disabled = true
        void api.appRun
          .setup(owner, { platform: 'apple', action: 'install-ios-runtime' })
          .then((result) => {
            operation = result ?? undefined
            setupHost.hidden = true
            renderOperation()
          })
          .catch(fail)
      })
      installApple.replaceWith(confirm)
    })
    setupHost.replaceChildren(
      el('strong', {}, 'Create a device'),
      el('label', {}, 'Runtime', runtime),
      el('label', {}, 'Device type', deviceType),
      el('label', {}, 'Name', name),
      explanation,
      el('div', { class: 'app-run-actions' }, apply, installApple, dismiss),
    )
    sync()
  }
  appSelect.addEventListener('change', () => {
    void selectApp()
  })
  variantSelect.addEventListener('change', () => {
    void loadDevices(deviceSelect.value)
  })
  refresh.addEventListener('click', () => {
    void discover()
  })
  create.addEventListener('click', () => {
    void showSetup(currentApp()?.platform ?? discovery.issues[0]?.platform ?? 'android')
  })
  run.addEventListener('click', () => {
    void execute('run')
  })
  build.addEventListener('click', () => {
    void execute('build')
  })
  test.addEventListener('click', () => {
    void execute('test')
  })
  cancel.addEventListener('click', () => {
    if (operation) void api.appRun.cancel(owner, operation.id).catch(fail)
  })
  stop.addEventListener('click', () => {
    if (operation) void api.appRun.stop(owner, operation.id).catch(fail)
  })
  void discover()
  void poll()
  return {
    element,
    dispose: (): void => {
      disposed = true
      deviceGeneration++
      setupGeneration++
      if (timer) clearTimeout(timer)
      void api.appRun.cancelDiscovery(owner).catch(() => {})
    },
  }
}

export function openAppRunDialog(
  store: AppStore,
  api: ApiClient,
  projectId = store.getState().activeProjectId,
): void {
  if (!projectId || document.querySelector('#app-run-dialog[open]')) return
  const state = store.getState()
  const owner: AppRunOwner = {
    projectId,
    ...(state.activeProjectId === projectId && state.activeThreadId
      ? { threadId: state.activeThreadId }
      : {}),
  }
  const { dialog, open, close } = createOverlayDialog({ id: 'app-run-dialog' })
  dialog.setAttribute('aria-labelledby', 'app-run-title')
  const closeButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost', 'aria-label': 'Close Run app' },
    closeIcon(),
  )
  closeButton.addEventListener('click', close)
  const panel = createAppRunPanel(api, owner, close)
  dialog.append(
    el(
      'header',
      { class: 'app-run-heading' },
      el('h2', { id: 'app-run-title' }, 'Run app'),
      closeButton,
    ),
    panel.element,
  )
  const unsubscribe = store.on('workspace_changed', close)
  const unsubscribeThread = store.on('threads_changed', () => {
    if (store.getState().activeThreadId !== (owner.threadId ?? null)) close()
  })
  dialog.addEventListener(
    'close',
    () => {
      unsubscribe()
      unsubscribeThread()
      panel.dispose()
      dialog.remove()
    },
    { once: true },
  )
  open()
}
