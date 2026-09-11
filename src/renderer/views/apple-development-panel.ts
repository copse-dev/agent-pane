import type { AppStore } from '@shared/store/store.ts'
import type {
  AppleAction,
  AppleDestination,
  AppleOperation,
  AppleProjectState,
} from '@shared/types/apple-development.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { refreshIcon } from '../dom/icons.ts'

interface ApplePanelOptions {
  allowEnrollment: boolean
  pluginEnabled?: boolean
}

function activeOwner(store: AppStore): { projectId: string; threadId: string } | null {
  const state = store.getState()
  return state.activeProjectId && state.activeThreadId
    ? { projectId: state.activeProjectId, threadId: state.activeThreadId }
    : null
}

function operationDuration(operation: AppleOperation): string {
  const end =
    operation.status === 'queued' || operation.status === 'running'
      ? Date.now()
      : operation.updatedAt
  const seconds = Math.max(0, Math.round((end - operation.createdAt) / 1_000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}m`
}

function operationStatusLabel(operation: AppleOperation): string {
  const elapsed = operationDuration(operation)
  switch (operation.status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return `Running · ${elapsed}`
    case 'succeeded':
      return `Succeeded · ${elapsed}`
    case 'failed':
      return `Failed · ${elapsed}`
    case 'cancelled':
      return `Cancelled · ${elapsed}`
  }
}

function operationDetail(operation: AppleOperation): string | null {
  if (operation.outcome?.reason) return operation.outcome.reason
  const summary = operation.outcome?.testSummary
  if (summary) {
    return `${String(summary.passed ?? '?')} passed · ${String(summary.failed ?? '?')} failed · ${String(summary.skipped ?? '?')} skipped`
  }
  if (operation.status === 'queued') return 'Waiting for the current Apple operation to finish.'
  if (operation.status === 'running') {
    if (operation.action === 'test') return 'Xcode is building and running the selected tests.'
    if (operation.action === 'run') return 'Xcode is building the app before launch.'
    return 'Xcode is building the selected scheme.'
  }
  if (operation.status === 'succeeded' && operation.action === 'run') {
    return operation.outcome?.appSessionId
      ? 'App launched and is still tracked by Copse.'
      : 'App launched.'
  }
  if (operation.status === 'succeeded' && operation.action === 'build') return 'Build completed.'
  return null
}

function preferredDestinationId(
  destinations: readonly AppleDestination[],
  savedId: string | undefined,
  previousId: string | undefined,
): string {
  for (const id of [savedId, previousId]) {
    if (id && destinations.some((destination) => destination.id === id)) return id
  }
  return destinations.find((destination) => destination.booted)?.id ?? destinations[0]?.id ?? ''
}

export function createAppleDevelopmentPanel(
  store: AppStore,
  api: ApiClient,
  options: ApplePanelOptions,
): HTMLElement {
  const host = el('div', { class: 'apple-development-host' })
  let generation = 0
  let renderedOwnerKey: string | null = null
  let polling: ReturnType<typeof setTimeout> | null = null
  let destinationRequest = 0
  const destinationCache = new Map<string, AppleDestination[]>()

  const stopPolling = (): void => {
    if (polling) clearTimeout(polling)
    polling = null
  }

  const run = async (
    button: HTMLButtonElement,
    action: () => Promise<void>,
    pendingLabel?: string,
  ): Promise<void> => {
    const pendingLabelNode = button.querySelector<HTMLElement>('[data-pending-label]')
    const label = pendingLabelNode?.textContent ?? button.textContent
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    if (pendingLabel) {
      if (pendingLabelNode) pendingLabelNode.textContent = pendingLabel
      else button.textContent = pendingLabel
      button.setAttribute('aria-label', pendingLabel)
      button.setAttribute('data-tooltip', pendingLabel)
    }
    try {
      await action()
      await refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      host.querySelector('.apple-development-error')?.remove()
      host.append(el('p', { class: 'apple-development-error', role: 'alert' }, message))
    } finally {
      button.disabled = false
      button.removeAttribute('aria-busy')
      if (pendingLabel) {
        if (pendingLabelNode) pendingLabelNode.textContent = label
        else button.textContent = label
        button.setAttribute('aria-label', label)
        button.setAttribute('data-tooltip', label)
      }
    }
  }

  const actionButton = (
    label: string,
    action: AppleAction,
    owner: { projectId: string; threadId: string },
    state: AppleProjectState,
  ): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'btn btn-secondary' }, label)
    button.disabled =
      state.selection === null ||
      state.operations.some(
        (operation) => operation.status === 'queued' || operation.status === 'running',
      )
    button.addEventListener('click', () => {
      const { selection } = state
      if (!selection) return
      void run(button, async () => {
        await api.appleDevelopment.execute(owner.projectId, owner.threadId, {
          action,
          expectedRevision: selection.revision,
          requestId: crypto.randomUUID(),
        })
      })
    })
    return button
  }

  const render = (
    owner: { projectId: string; threadId: string },
    state: AppleProjectState,
  ): void => {
    stopPolling()
    renderedOwnerKey = `${owner.projectId}\0${owner.threadId}`
    host.replaceChildren()
    const latestOperation = state.operations[0]
    if ((!state.pluginEnabled || !state.enrolled) && !latestOperation && !options.allowEnrollment) {
      host.hidden = true
      return
    }
    host.hidden = false
    const panel = el('section', {
      class: 'apple-development-panel',
      'data-plugin-id': 'copse.apple-development',
      'aria-label': 'Apple Development',
    })
    const title = el('h3', { class: 'apple-development-title' }, 'Apple development')
    const status = el(
      'span',
      { class: 'apple-development-status' },
      state.toolchain?.version.split('\n')[0] ??
        (state.selection
          ? 'Target saved'
          : state.supportedHost
            ? 'Setup needed'
            : 'Unsupported host'),
    )
    const headingActions = el('div', { class: 'apple-development-heading-actions' })
    panel.append(el('div', { class: 'apple-development-heading' }, title, status, headingActions))

    if (options.allowEnrollment && options.pluginEnabled !== false) {
      const enrollment = el(
        'button',
        { type: 'button', class: 'btn btn-secondary' },
        state.enrolled ? 'Remove project' : 'Enroll project',
      )
      enrollment.addEventListener('click', () => {
        void run(enrollment, async () => {
          await api.appleDevelopment.setEnrolled(owner.projectId, owner.threadId, !state.enrolled)
        })
      })
      panel.append(enrollment)
    }

    if (state.setupMessage) {
      panel.append(el('p', { class: 'apple-development-message' }, state.setupMessage))
    }

    if (state.pluginEnabled && state.enrolled && state.supportedHost) {
      const discoverLabel = state.metadataRequiresExecution
        ? 'Load schemes and destinations'
        : 'Refresh targets'
      const discover = el(
        'button',
        {
          type: 'button',
          class: 'git-changes-refresh-btn apple-development-discover',
          'aria-label': discoverLabel,
          'data-tooltip': discoverLabel,
        },
        refreshIcon('ui-icon ui-icon-sm'),
        el('span', { class: 'sr-only', 'data-pending-label': '' }, discoverLabel),
      )
      discover.addEventListener('click', () => {
        void run(
          discover,
          async () => {
            destinationCache.clear()
            await api.appleDevelopment.discover(owner.projectId, owner.threadId, true)
          },
          'Loading targets…',
        )
      })
      headingActions.append(discover)

      if (state.candidates.length > 0 && state.destinations.length > 0) {
        const candidate = el('select', { 'aria-label': 'Xcode project' })
        for (const item of state.candidates) {
          candidate.append(
            el(
              'option',
              {
                value: item.id,
                selected: state.selection?.candidateId === item.id ? true : undefined,
              },
              item.name,
            ),
          )
        }
        const scheme = el('select', { 'aria-label': 'Scheme' })
        const destination = el('select', { 'aria-label': 'Destination' })
        const schemeStatus = el('p', {
          class: 'apple-development-scheme-status',
          role: 'status',
        })
        const destinationStatus = el('p', {
          class: 'apple-development-scheme-status',
          role: 'status',
        })
        const save = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Use target')
        const fillDestinations = (items: AppleDestination[]): void => {
          const previousId = destination.value
          destination.replaceChildren(
            ...items.map((item) =>
              el('option', { value: item.id }, `${item.name} · ${item.platform}`),
            ),
          )
          const savedId =
            state.selection?.candidateId === candidate.value &&
            state.selection.schemeId === scheme.value
              ? state.selection.destinationId
              : undefined
          destination.value = preferredDestinationId(items, savedId, previousId)
          destination.disabled = items.length === 0
          save.disabled = items.length === 0
          destinationStatus.hidden = true
        }
        const loadDestinations = async (): Promise<void> => {
          if (scheme.value === '') {
            destination.replaceChildren(el('option', { value: '' }, 'No destinations available'))
            destination.disabled = true
            save.disabled = true
            return
          }
          const candidateId = candidate.value
          const schemeId = scheme.value
          const key = `${owner.projectId}\0${owner.threadId}\0${candidateId}\0${schemeId}`
          const cached = destinationCache.get(key)
          if (cached) {
            fillDestinations(cached)
            return
          }
          const request = ++destinationRequest
          destination.replaceChildren(el('option', { value: '' }, 'Loading destinations…'))
          destination.disabled = true
          save.disabled = true
          destinationStatus.hidden = true
          try {
            const items = await api.appleDevelopment.destinations(
              owner.projectId,
              owner.threadId,
              candidateId,
              schemeId,
            )
            if (
              request !== destinationRequest ||
              candidate.value !== candidateId ||
              scheme.value !== schemeId
            ) {
              return
            }
            destinationCache.set(key, items)
            fillDestinations(items)
          } catch (error) {
            if (request !== destinationRequest) return
            destination.replaceChildren(el('option', { value: '' }, 'No destinations available'))
            destination.disabled = true
            save.disabled = true
            destinationStatus.textContent = error instanceof Error ? error.message : String(error)
            destinationStatus.hidden = false
          }
        }
        const fillSchemes = (): void => {
          const selected = state.candidates.find((item) => item.id === candidate.value)
          const schemes = selected?.schemes ?? []
          scheme.replaceChildren(
            ...(schemes.length === 0
              ? [el('option', { value: '' }, 'No schemes available')]
              : schemes.map((name) =>
                  el(
                    'option',
                    {
                      value: name,
                      selected: state.selection?.schemeId === name ? true : undefined,
                    },
                    name,
                  ),
                )),
          )
          scheme.disabled = schemes.length === 0
          schemeStatus.textContent =
            selected?.metadataError ??
            (schemes.length === 0 ? 'Load target metadata to choose a scheme.' : '')
          schemeStatus.hidden = schemeStatus.textContent === ''
          void loadDestinations()
        }
        fillSchemes()
        candidate.addEventListener('change', fillSchemes)
        scheme.addEventListener('change', () => void loadDestinations())
        const configuration = el(
          'select',
          { 'aria-label': 'Configuration' },
          ...['Debug', 'Release'].map((name) =>
            el(
              'option',
              {
                value: name,
                selected: (state.selection?.configuration ?? 'Debug') === name ? true : undefined,
              },
              name,
            ),
          ),
        )
        save.addEventListener('click', () => {
          if (scheme.value === '') return
          void run(save, async () => {
            await api.appleDevelopment.configure(owner.projectId, owner.threadId, {
              candidateId: candidate.value,
              schemeId: scheme.value,
              configuration: configuration.value,
              destinationId: destination.value,
              expectedRevision: state.selection?.revision ?? 0,
            })
          })
        })
        panel.append(
          el(
            'details',
            {
              class: 'apple-development-target-picker',
              open: state.selection ? undefined : true,
            },
            el('summary', {}, state.selection ? 'Change target' : 'Choose target'),
            el(
              'div',
              { class: 'apple-development-selection' },
              candidate,
              scheme,
              configuration,
              destination,
              save,
              schemeStatus,
              destinationStatus,
            ),
          ),
        )
      }

      if (state.selection) {
        const selectedDestination = state.destinations.find(
          (destination) => destination.id === state.selection?.destinationId,
        )
        panel.append(
          el(
            'div',
            { class: 'apple-development-target', 'aria-label': 'Selected Apple target' },
            el(
              'div',
              { class: 'apple-development-target-name' },
              el('strong', {}, state.selection.schemeId),
              el('span', {}, state.selection.candidateId),
            ),
            el(
              'div',
              { class: 'apple-development-target-meta' },
              el('span', {}, state.selection.configuration),
              el('span', {}, selectedDestination?.name ?? state.selection.destinationId),
            ),
            el(
              'div',
              { class: 'apple-development-actions' },
              actionButton('Build', 'build', owner, state),
              actionButton('Test', 'test', owner, state),
              actionButton('Run', 'run', owner, state),
            ),
          ),
        )
      }
    }

    if (latestOperation) {
      const history = el('ul', { class: 'apple-development-operations', role: 'list' })
      for (const operation of [latestOperation]) {
        const controls = el('div', { class: 'apple-development-operation-controls' })
        if (operation.status === 'queued' || operation.status === 'running') {
          const cancel = el('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel')
          cancel.addEventListener('click', () => {
            void run(cancel, async () => {
              await api.appleDevelopment.operation(owner.projectId, owner.threadId, {
                operationId: operation.id,
                action: 'cancel',
              })
            })
          })
          controls.append(cancel)
        }
        if (operation.outcome?.appSessionId) {
          const stop = el('button', { type: 'button', class: 'btn btn-ghost' }, 'Stop app')
          stop.addEventListener('click', () => {
            const appSessionId = operation.outcome?.appSessionId
            if (!appSessionId) return
            void run(stop, async () => {
              await api.appleDevelopment.stopApp(owner.projectId, owner.threadId, appSessionId)
            })
          })
          controls.append(stop)
        }
        const detail = operationDetail(operation)
        history.append(
          el(
            'li',
            {
              class: `apple-development-operation apple-development-operation-${operation.status}`,
              'data-operation-id': operation.id,
            },
            el(
              'div',
              { class: 'apple-development-operation-line' },
              el('span', { class: 'apple-development-operation-indicator', 'aria-hidden': 'true' }),
              el('span', { class: 'apple-development-operation-action' }, operation.action),
              el(
                'span',
                { class: 'apple-development-operation-status' },
                operationStatusLabel(operation),
              ),
              controls,
            ),
            ...(detail
              ? [el('span', { class: 'apple-development-operation-detail' }, detail)]
              : []),
          ),
        )
      }
      panel.append(history)
    }
    host.append(panel)
    if (
      state.operations.some(
        (operation) => operation.status === 'queued' || operation.status === 'running',
      )
    ) {
      polling = setTimeout(() => void refresh(), 1_500)
    }
  }

  const refresh = async (): Promise<void> => {
    const owner = activeOwner(store)
    const current = ++generation
    if (!owner) {
      stopPolling()
      host.replaceChildren()
      host.hidden = true
      return
    }
    const ownerKey = `${owner.projectId}\0${owner.threadId}`
    if (renderedOwnerKey !== ownerKey) {
      stopPolling()
      host.replaceChildren()
      host.hidden = true
    }
    try {
      const state = await api.appleDevelopment.state(owner.projectId, owner.threadId)
      if (current === generation) render(owner, state)
    } catch (error) {
      if (current !== generation) return
      host.hidden = false
      host.replaceChildren(
        el(
          'p',
          { class: 'apple-development-error', role: 'alert' },
          error instanceof Error ? error.message : String(error),
        ),
      )
    }
  }

  host.addEventListener('apple-development-refresh', () => {
    void refresh()
  })
  void refresh()
  return host
}
