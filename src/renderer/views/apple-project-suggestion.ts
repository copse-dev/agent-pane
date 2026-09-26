import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { AppleProjectSuggestion } from '@shared/types/apple-development.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { projectDisplayName } from '../controller/projects.ts'
import { el } from '../dom/helpers.ts'
import { sparkleIcon } from '../dom/icons.ts'
import { createOverlayDialog } from './dialog-shell.ts'
import { showErrorToast, showToast } from './toast.ts'

/**
 * Offer Apple development when an Apple project becomes active.
 *
 * Detection runs whether or not the plugin is on. The first time a detected
 * project opens, a dialog asks; accepting turns the plugin on if it is off and
 * allows it in that project. "Not now" earns one quiet reminder at the top of
 * the thread on a later launch; "Don't ask" (or dismissing the reminder) ends
 * it for that project. Each project is asked at most once per app session.
 */

export type AppleSuggestionChoice = 'turn-on' | 'not-now' | 'dont-ask'

const PLUGIN_NAME = 'Apple development'
const PLUGIN_DESCRIPTION =
  'Build, test, and run local Apple projects with an installed Xcode. Adds thread-scoped target selection, supervised operations, diagnostics, and Simulator controls.'

/** The Settings → Plugins card, reused so the plugin reads as the same object. */
function pluginCard(): HTMLElement {
  const mark = el('img', { src: './brand-mark.svg', alt: '', width: '40', height: '40' })
  const icon = el('span', { class: 'plugin-icon plugin-icon-copse', 'aria-hidden': 'true' }, mark)
  const stability = el('span', { class: 'plugin-badge plugin-badge-experimental' }, 'experimental')
  const nameLine = el(
    'div',
    { class: 'plugin-row-name-line' },
    el('span', { class: 'plugin-name' }, PLUGIN_NAME),
    stability,
  )
  const title = el(
    'div',
    { class: 'plugin-row-title' },
    el('span', { class: 'plugin-badge plugin-badge-first-party' }, 'Copse'),
    nameLine,
  )
  return el(
    'div',
    { class: 'plugin-row apple-suggestion-card' },
    el('div', { class: 'plugin-row-header' }, icon, title),
    el('div', { class: 'plugin-row-desc' }, PLUGIN_DESCRIPTION),
  )
}

/** Ask once, in the app's dialog material. Escape counts as "Not now". */
export function showAppleSuggestionDialog(options: {
  projectName: string
  pluginEnabled: boolean
}): Promise<AppleSuggestionChoice> {
  const { dialog, open, close } = createOverlayDialog({ id: 'apple-suggestion-dialog' })
  dialog.setAttribute('aria-labelledby', 'apple-suggestion-title')
  const { projectName, pluginEnabled } = options
  const heading = el(
    'h2',
    { id: 'apple-suggestion-title' },
    pluginEnabled ? `Use ${PLUGIN_NAME} in ${projectName}?` : `Turn on ${PLUGIN_NAME}?`,
  )
  const lede = el(
    'p',
    { class: 'apple-suggestion-lede' },
    pluginEnabled
      ? `${projectName} looks like an Apple project. ${PLUGIN_NAME} is already on — allow the agent to build, run, and debug this project too.`
      : `${projectName} looks like an Apple project. Copse has a plugin that lets the agent build, run, and debug it. Turning it on allows it for ${projectName}.`,
  )
  const dontAsk = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost apple-suggestion-dont-ask' },
    "Don't ask for this project",
  )
  const notNow = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary apple-suggestion-not-now' },
    'Not now',
  )
  const accept = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary apple-suggestion-accept' },
    pluginEnabled ? 'Allow' : 'Turn on',
  )
  const actions = el(
    'div',
    { class: 'ui-actions apple-suggestion-actions' },
    dontAsk,
    el('span', { class: 'apple-suggestion-spacer' }),
    notNow,
    accept,
  )
  dialog.append(heading, lede, pluginCard(), actions)

  return new Promise((resolve) => {
    let choice: AppleSuggestionChoice = 'not-now'
    const choose = (next: AppleSuggestionChoice): void => {
      choice = next
      close()
    }
    dontAsk.addEventListener('click', () => {
      choose('dont-ask')
    })
    notNow.addEventListener('click', () => {
      choose('not-now')
    })
    accept.addEventListener('click', () => {
      choose('turn-on')
    })
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove()
        resolve(choice)
      },
      { once: true },
    )
    open()
    accept.focus()
  })
}

interface Reminder {
  projectId: string
  pluginEnabled: boolean
}

/**
 * Watch project activation and offer the plugin. Returns the reminder host,
 * which the conversation mounts at the top of the thread.
 */
export function mountAppleProjectSuggestions(
  store: AppStore,
  api: ApiClient,
  onAllowed: () => void,
): HTMLElement {
  const text = el('span', { class: 'apple-suggestion-notice-text' })
  const acceptLink = el('button', { type: 'button', class: 'apple-suggestion-notice-accept' })
  const dismissLink = el(
    'button',
    { type: 'button', class: 'apple-suggestion-notice-dismiss' },
    'Dismiss',
  )
  const host = el(
    'div',
    { class: 'apple-suggestion-notice', role: 'status', hidden: true },
    sparkleIcon('ui-icon'),
    text,
    acceptLink,
    dismissLink,
  )
  const asked = new Set<string>()
  let reminder: Reminder | null = null

  const projectName = (projectId: string): string => {
    const project = store.getState().projects.find((candidate) => candidate.id === projectId)
    return project ? projectDisplayName(project) : 'This project'
  }

  const renderReminder = (): void => {
    const active = store.getState().activeProjectId
    if (!reminder || reminder.projectId !== active) {
      host.hidden = true
      return
    }
    const name = projectName(reminder.projectId)
    text.textContent = reminder.pluginEnabled
      ? `${PLUGIN_NAME} isn't allowed in ${name}.`
      : `${PLUGIN_NAME} is off for ${name}.`
    acceptLink.textContent = reminder.pluginEnabled ? 'Allow' : 'Turn on'
    host.hidden = false
  }

  const accept = async (projectId: string, pluginEnabled: boolean): Promise<void> => {
    reminder = null
    renderReminder()
    const threadId = store.getState().activeThreadId
    if (!threadId || store.getState().activeProjectId !== projectId) return
    try {
      if (!pluginEnabled) {
        await api.plugins.setEnabled(APPLE_DEVELOPMENT_PLUGIN_ID, true)
        store.emit('settings_changed')
      }
      await api.appleDevelopment.setEnrolled(projectId, threadId, true)
      onAllowed()
      const name = projectName(projectId)
      showToast(
        pluginEnabled
          ? `${PLUGIN_NAME} is allowed in ${name}.`
          : `${PLUGIN_NAME} is on and allowed in ${name}. Change this in Settings → Plugins.`,
      )
    } catch (error) {
      showErrorToast(`Could not turn on ${PLUGIN_NAME}`, error)
    }
  }

  const answer = (projectId: string, choice: 'snoozed' | 'dismissed'): void => {
    void api.appleDevelopment.answerSuggestion(projectId, choice).catch((error: unknown) => {
      showErrorToast('Could not save your answer', error)
    })
  }

  const offer = async (projectId: string, suggestion: AppleProjectSuggestion): Promise<void> => {
    if (suggestion.offer === 'reminder') {
      reminder = { projectId, pluginEnabled: suggestion.pluginEnabled }
      renderReminder()
      return
    }
    if (suggestion.offer !== 'dialog') return
    const choice = await showAppleSuggestionDialog({
      projectName: projectName(projectId),
      pluginEnabled: suggestion.pluginEnabled,
    })
    if (choice === 'turn-on') await accept(projectId, suggestion.pluginEnabled)
    else answer(projectId, choice === 'dont-ask' ? 'dismissed' : 'snoozed')
  }

  const evaluate = async (): Promise<void> => {
    renderReminder()
    const { activeProjectId, activeThreadId } = store.getState()
    if (!activeProjectId || !activeThreadId || asked.has(activeProjectId)) return
    asked.add(activeProjectId)
    let suggestion: AppleProjectSuggestion
    try {
      suggestion = await api.appleDevelopment.suggestion(activeProjectId)
    } catch {
      // A failed probe is not an answer; try again next time the project opens.
      asked.delete(activeProjectId)
      return
    }
    // The user moved on while the probe ran; ask when they come back.
    if (store.getState().activeProjectId !== activeProjectId) {
      asked.delete(activeProjectId)
      return
    }
    await offer(activeProjectId, suggestion)
  }

  acceptLink.addEventListener('click', () => {
    if (reminder) void accept(reminder.projectId, reminder.pluginEnabled)
  })
  dismissLink.addEventListener('click', () => {
    if (!reminder) return
    // The reminder was the one second chance; dismissing it ends the ask.
    answer(reminder.projectId, 'dismissed')
    reminder = null
    renderReminder()
  })

  store.on('workspace_changed', () => void evaluate())
  // Launch may restore the project before this mounts.
  void evaluate()
  return host
}
