import type {
  ProfileVaultAction,
  ProfileVaultApi,
  ProfileVaultStatus,
} from '@shared/types/profile-vault.ts'
import { el } from '../dom/helpers.ts'

/** No recovery key or plaintext credential is part of this view's API. */
export function createProfileVaultSection(api: ProfileVaultApi | undefined): HTMLElement {
  const root = el('fieldset', {
    class: 'profile-vault-section',
    'data-testid': 'profile-vault-section',
  })
  const legend = el('legend', {}, 'Saved-secret encryption')
  const description = el(
    'p',
    { class: 'settings-fieldset-desc' },
    'Protect saved API keys and SSH/VNC credentials with this Mac’s Secure Enclave. Unlock with Touch ID or macOS authentication. Conversations, repositories and browser cookies are not encrypted by this option.',
  )
  const status = el(
    'p',
    { class: 'field-hint', role: 'status', 'aria-live': 'polite' },
    'Checking availability…',
  )
  const controls = el('div', { class: 'profile-vault-controls' })
  const notice = el('p', { class: 'field-hint', role: 'status', 'aria-live': 'polite' })
  root.append(legend, description, status, controls, notice)
  let pending = false
  const run = async (action: ProfileVaultAction): Promise<void> => {
    if (!api || pending) return
    pending = true
    for (const button of controls.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button, input',
    ))
      button.disabled = true
    notice.textContent = 'Complete the native authentication window to continue.'
    try {
      const result = await api.run(action)
      notice.textContent = result.ok
        ? action.action === 'enable' || action.action === 'lock' || action.action === 'recover'
          ? 'Restarting Copse with saved secrets locked…'
          : 'Done.'
        : result.reason === 'cancelled'
          ? 'Cancelled. Your saved credentials are unchanged.'
          : result.reason === 'locked'
            ? 'Unlock saved secrets to continue.'
            : result.reason === 'recovery-required'
              ? 'This Mac does not have the device key. Restore access with your recovery key.'
              : result.reason === 'corrupt'
                ? 'Verification failed. Check the recovery key and restore a complete profile backup if needed.'
                : result.reason === 'unavailable'
                  ? 'The native encryption helper or macOS authentication is unavailable.'
                  : result.reason
    } catch {
      notice.textContent = 'Could not reach the encryption service.'
    } finally {
      pending = false
      await refresh()
    }
  }
  const button = (label: string, action: ProfileVaultAction): HTMLButtonElement => {
    const control = el('button', { type: 'button', class: 'ui-btn' }, label)
    control.addEventListener('click', () => {
      void run(action)
    })
    return control
  }
  const render = (current: ProfileVaultStatus): void => {
    root.dataset['state'] = current.state
    controls.replaceChildren()
    if (current.state === 'busy' || current.state === 'unlocking') {
      status.textContent = 'Complete the native authentication window to continue.'
      return
    }
    if (!current.available) {
      status.textContent = current.enabled
        ? 'Saved secrets are encrypted and locked. The signed macOS helper is unavailable in this build.'
        : 'Available on Macs with Secure Enclave and the signed Copse encryption helper.'
      return
    }
    if (!current.enabled) {
      status.textContent = 'Uses existing OS secure storage until enabled. Setup restarts Copse.'
      const backup = el('input', { type: 'checkbox' })
      backup.checked = true
      const backupLabel = el('label', { class: 'profile-vault-choice' })
      backupLabel.append(
        backup,
        document.createTextNode('Back up a recovery key in my password manager (recommended)'),
      )
      const acknowledge = el('input', { type: 'checkbox' })
      const lossLabel = el('label', { class: 'profile-vault-choice' })
      lossLabel.append(
        acknowledge,
        document.createTextNode(
          'I understand that losing this Mac’s device key will make my saved secrets unrecoverable without a recovery backup.',
        ),
      )
      lossLabel.hidden = true
      const enable = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-primary' },
        'Enable encryption',
      )
      enable.addEventListener('click', () => {
        void run({ action: 'enable', backup: backup.checked })
      })
      const updateChoice = (): void => {
        lossLabel.hidden = backup.checked
        enable.disabled = !backup.checked && !acknowledge.checked
      }
      backup.addEventListener('change', updateChoice)
      acknowledge.addEventListener('change', updateChoice)
      controls.append(backupLabel, lossLabel, enable)
      return
    }
    const unlocked = current.state === 'unlocked'
    status.textContent = `${unlocked ? 'Unlocked on this Mac.' : 'Saved secrets are locked.'} ${current.recovery === 'verified' ? 'Recovery key verified for this profile key.' : 'Recovery key not backed up.'}`
    const actions = el('div', { class: 'profile-vault-actions' })
    actions.append(
      button(unlocked ? 'Lock and restart' : 'Unlock', { action: unlocked ? 'lock' : 'unlock' }),
      button('Back up recovery key', { action: 'backup' }),
      button('Restore access', { action: 'recover' }),
    )
    controls.append(
      actions,
      el(
        'p',
        { class: 'field-hint' },
        'Keep a separate backup of your profile files. A recovery key cannot restore deleted files. Locking restarts Copse and stops running work to clear cached credentials.',
      ),
    )
  }
  async function refresh(): Promise<void> {
    if (!api) {
      render({ state: 'unavailable', available: false, enabled: false, recovery: 'not-backed-up' })
      return
    }
    try {
      render(await api.status())
    } catch {
      status.textContent = 'Could not read saved-secret encryption status.'
    }
  }
  void refresh()
  return root
}
