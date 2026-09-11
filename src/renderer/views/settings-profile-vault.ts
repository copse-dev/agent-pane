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
    'Saved API keys and SSH/VNC credentials are automatically protected with this Mac’s Secure Enclave on supported Macs. Copse normally unlocks them silently. Conversations, repositories and browser cookies are outside this protection.',
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
    notice.textContent =
      action.action === 'retry-migration' || action.action === 'unlock'
        ? 'Opening saved-secret encryption…'
        : 'Complete the native authentication window to continue.'
    try {
      const result = await api.run(action)
      notice.textContent = result.ok
        ? action.action === 'retry-migration' || action.action === 'recover'
          ? 'Restarting Copse…'
          : action.action === 'set-auth'
            ? 'Updated. The startup authentication setting takes effect next time you launch Copse.'
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
      status.textContent = 'Updating saved-secret encryption…'
      return
    }
    if (!current.available) {
      status.textContent = current.enabled
        ? 'Saved secrets are encrypted and locked. The signed macOS helper is unavailable in this build.'
        : 'Available on Macs with Secure Enclave and the signed Copse encryption helper.'
      return
    }
    if (!current.enabled) {
      status.textContent = current.migrationFailed
        ? 'Automatic migration could not finish. Your credentials still use the existing OS secure storage. Close other Copse processes and retry.'
        : current.automatic
          ? 'This profile will migrate automatically when Copse starts.'
          : 'Uses existing OS secure storage. Automatic device encryption requires a supported signed Copse release.'
      if (current.automatic)
        controls.append(button('Retry migration', { action: 'retry-migration' }))
      return
    }
    const unlocked = current.state === 'unlocked'
    status.textContent = `${unlocked ? 'Unlocked on this Mac.' : 'Saved secrets are locked.'} ${current.recovery === 'verified' ? 'Recovery key verified for this profile key.' : 'Recovery key not backed up.'}`
    const authentication = el('input', { type: 'checkbox' })
    authentication.checked = current.requireAuth ?? true
    const authenticationLabel = el('label', { class: 'profile-vault-choice' })
    authenticationLabel.append(
      authentication,
      document.createTextNode('Require authentication when Copse starts'),
    )
    authentication.addEventListener('change', () => {
      void run({ action: 'set-auth', requireAuth: authentication.checked })
    })
    controls.append(
      authenticationLabel,
      el(
        'p',
        { class: 'field-hint' },
        'Once unlocked, saved secrets remain available through sleep and screen lock until you quit. Exporting a recovery key always requires authentication.',
      ),
    )
    const actions = el('div', { class: 'profile-vault-actions' })
    if (!unlocked) actions.append(button('Unlock', { action: 'unlock' }))
    actions.append(
      button('Back up recovery key', { action: 'backup' }),
      button('Restore access', { action: 'recover' }),
    )
    controls.append(
      actions,
      el(
        'p',
        { class: 'field-hint' },
        'Keep a separate backup of your profile files. A recovery key cannot restore deleted files.',
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
