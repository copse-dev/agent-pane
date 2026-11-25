import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { setInlineStatus } from '../dom/inline-status.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'

/**
 * Where SSH workspaces are first used, say what turning them on means and turn
 * them on with one click, instead of sending the user to Settings and back.
 *
 * Only the place consent is given moves: the main process still refuses every
 * remote operation while `sshWorkspaceEnabled` is off, and Settings → Machines
 * still turns it off again.
 */
export interface SshWorkspaceConsent {
  readonly root: HTMLElement
}

export interface SshWorkspaceConsentOptions {
  /** Called once the setting is saved on. */
  onEnabled: () => void | Promise<void>
  /** Shown beside the turn-on button when set; the caller decides what declining does. */
  onCancel?: () => void
}

export const SSH_WORKSPACE_CONSENT_TITLE = 'Turn on SSH workspaces?'

export const SSH_WORKSPACE_CONSENT_BODY =
  'Copse will run shell, git, search and file tools on the machine you choose, over your own ' +
  'SSH setup. Copse applies no sandbox there, so it asks before running ordinary commands, ' +
  'as it does wherever commands run unsandboxed.'

export function createSshWorkspaceConsent(
  api: ApiClient,
  options: SshWorkspaceConsentOptions,
): SshWorkspaceConsent {
  const status = el('p', { class: 'ssh-consent-status', role: 'status' })
  const turnOn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary ssh-consent-turn-on' },
    'Turn on SSH workspaces',
  )
  const actions = el('div', { class: 'ssh-consent-actions' })
  if (options.onCancel) {
    const cancel = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary ssh-consent-cancel' },
      'Cancel',
    )
    const onCancel = options.onCancel
    cancel.addEventListener('click', () => {
      onCancel()
    })
    actions.append(cancel)
  }
  actions.append(turnOn)
  const root = el(
    'div',
    { class: 'ssh-consent', role: 'group', 'aria-label': SSH_WORKSPACE_CONSENT_TITLE },
    el('p', { class: 'ssh-consent-title' }, SSH_WORKSPACE_CONSENT_TITLE),
    el('p', { class: 'ssh-consent-body' }, SSH_WORKSPACE_CONSENT_BODY),
    el(
      'p',
      { class: 'ssh-consent-hint field-hint' },
      'You can turn it off again in Settings → Machines.',
    ),
    status,
    actions,
  )
  turnOn.addEventListener('click', () => {
    void (async (): Promise<void> => {
      turnOn.disabled = true
      try {
        await api.settings.set('sshWorkspaceEnabled', true)
        status.replaceChildren()
        await options.onEnabled()
      } catch (error) {
        setInlineStatus(
          status,
          'error',
          ipcErrorMessage(error, 'Could not turn on SSH workspaces.'),
        )
      } finally {
        turnOn.disabled = false
      }
    })()
  })
  return { root }
}
