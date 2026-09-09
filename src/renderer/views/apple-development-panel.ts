import type { AppStore } from '@shared/store/store.ts'
import type { AppleAction, AppleProjectState } from '@shared/types/apple-development.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'

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

export function createAppleDevelopmentPanel(
  store: AppStore,
  api: ApiClient,
  options: ApplePanelOptions,
): HTMLElement {
  const host = el('div', { class: 'apple-development-host' })
  let generation = 0
  let renderedOwnerKey: string | null = null
  let polling: ReturnType<typeof setTimeout> | null = null

  const stopPolling = (): void => {
    if (polling) clearTimeout(polling)
    polling = null
  }

  const run = async (
    button: HTMLButtonElement,
    action: () => Promise<void>,
    pendingLabel?: string,
  ): Promise<void> => {
    const label = button.textContent
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    if (pendingLabel) button.textContent = pendingLabel
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
      if (pendingLabel) button.textContent = label
    }
  }

  const actionButton = (
    label: string,
    action: AppleAction,
    owner: { projectId: string; threadId: string },
    state: AppleProjectState,
  ): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'btn btn-secondary' }, label)
    button.disabled = state.selection === null
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
    const hasHistory = state.operations.length > 0
    if ((!state.pluginEnabled || !state.enrolled) && !hasHistory && !options.allowEnrollment) {
      host.hidden = true
      return
    }
    host.hidden = false
    const panel = el('section', {
      class: 'apple-development-panel',
      'data-plugin-id': 'copse.apple-development',
      'aria-label': 'Apple Development',
    })
    const title = el('h3', { class: 'apple-development-title' }, 'Apple Development')
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
    panel.append(el('div', { class: 'apple-development-heading' }, title, status))

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
      const discover = el(
        'button',
        { type: 'button', class: 'btn btn-secondary apple-development-discover' },
        state.metadataRequiresExecution ? 'Load schemes and destinations' : 'Refresh targets',
      )
      discover.addEventListener('click', () => {
        void run(
          discover,
          async () => {
            await api.appleDevelopment.discover(owner.projectId, owner.threadId, true)
          },
          'Loading targets…',
        )
      })
      panel.append(discover)

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
        const schemeStatus = el('p', {
          class: 'apple-development-scheme-status',
          role: 'status',
        })
        const save = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Use target')
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
          save.disabled = schemes.length === 0
          schemeStatus.textContent =
            selected?.metadataError ??
            (schemes.length === 0 ? 'Load target metadata to choose a scheme.' : '')
          schemeStatus.hidden = schemeStatus.textContent === ''
        }
        fillSchemes()
        candidate.addEventListener('change', fillSchemes)
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
        const destination = el('select', { 'aria-label': 'Destination' })
        for (const item of state.destinations) {
          destination.append(
            el(
              'option',
              {
                value: item.id,
                selected: state.selection?.destinationId === item.id ? true : undefined,
              },
              `${item.name} · ${item.platform}`,
            ),
          )
        }
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
            'div',
            { class: 'apple-development-selection' },
            candidate,
            scheme,
            configuration,
            destination,
            save,
            schemeStatus,
          ),
        )
      }

      if (state.selection) {
        panel.append(
          el(
            'div',
            { class: 'apple-development-target', 'aria-label': 'Selected Apple target' },
            el('strong', {}, state.selection.schemeId),
            el('span', {}, state.selection.candidateId),
            el('span', {}, state.selection.configuration),
            el('span', {}, state.selection.destinationId),
          ),
        )
      }

      panel.append(
        el(
          'div',
          { class: 'apple-development-actions' },
          actionButton('Build', 'build', owner, state),
          actionButton('Test', 'test', owner, state),
          actionButton('Run', 'run', owner, state),
        ),
      )
    }

    if (hasHistory) {
      const history = el('ul', { class: 'apple-development-operations', role: 'list' })
      for (const operation of state.operations.slice(0, 5)) {
        const cancel = el('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel')
        cancel.hidden = operation.status !== 'queued' && operation.status !== 'running'
        cancel.addEventListener('click', () => {
          void run(cancel, async () => {
            await api.appleDevelopment.operation(owner.projectId, owner.threadId, {
              operationId: operation.id,
              action: 'cancel',
            })
          })
        })
        const summary = operation.outcome?.testSummary
        const detail =
          operation.outcome?.reason ??
          (summary
            ? `${String(summary.passed ?? '?')} passed · ${String(summary.failed ?? '?')} failed · ${String(summary.skipped ?? '?')} skipped`
            : null)
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
              el('span', { class: 'apple-development-operation-action' }, operation.action),
              el('span', { class: 'apple-development-operation-status' }, operation.status),
              cancel,
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
