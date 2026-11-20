import type { ApiClient } from '../../preload/api.d.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { el } from '../dom/helpers.ts'
import { setInlineStatus } from '../dom/inline-status.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import {
  parseSshWorkspaceHosts,
  saveSshConfigHost,
  unsavedSshConfigHosts,
  upsertHost,
} from './setup/ssh-host-helpers.ts'
import { createSshHostFields } from './setup/ssh-host-fields.ts'

export function createVncSshHostForm(
  api: ApiClient,
  onSaved: (hostId: string) => Promise<void>,
  onClose: () => void,
): { root: HTMLElement; open(): void; close(): void } {
  const hostFields = createSshHostFields({ labelClass: 'vnc-field-label' })
  // `~/.ssh/config` hosts not saved yet. Choosing one saves it alone, in the
  // alias-only form, so OpenSSH keeps applying its whole stanza.
  const configSelect = el('select', {
    class: 'vnc-ssh-config-host',
    'aria-label': 'Host in ~/.ssh/config',
  })
  const configField = el(
    'label',
    { class: 'vnc-field-label vnc-ssh-config-field', hidden: true },
    'In ~/.ssh/config',
    configSelect,
  )
  let configHosts: SshWorkspaceHost[] = []
  const status = el('p', { class: 'vnc-ssh-host-status', role: 'status' })
  const save = el('button', { type: 'submit', class: 'ui-btn ui-btn-primary' }, 'Save SSH machine')
  const cancel = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Cancel')
  const root = el(
    'form',
    { class: 'vnc-ssh-host-form', hidden: true, 'aria-label': 'Add SSH machine' },
    el('p', { class: 'vnc-ssh-host-hint' }, 'Use an SSH key to secure the desktop connection.'),
    configField,
    ...hostFields.fields,
    status,
    el('div', { class: 'vnc-ssh-host-actions' }, cancel, save),
  )
  function close(): void {
    root.hidden = true
    status.textContent = ''
    onClose()
  }
  async function loadConfigHosts(): Promise<void> {
    try {
      const [saved, aliases] = await Promise.all([
        api.sshWorkspace.listHosts(),
        api.sshWorkspace.listConfigAliases(),
      ])
      configHosts = unsavedSshConfigHosts(saved, aliases)
    } catch {
      configHosts = []
    }
    configSelect.replaceChildren(
      el('option', { value: '', selected: true }, 'Choose a host'),
      ...configHosts.map((host) => el('option', { value: host.host }, host.host)),
    )
    configField.hidden = configHosts.length === 0
  }
  function open(): void {
    root.reset()
    hostFields.reset()
    status.textContent = ''
    configField.hidden = true
    root.hidden = false
    hostFields.focus()
    void loadConfigHosts()
  }
  function busy(value: boolean): void {
    save.disabled = value
    configSelect.disabled = value
    cancel.disabled = value
  }
  async function requireSshEnabled(): Promise<boolean> {
    if ((await api.settings.get('sshWorkspaceEnabled')) === true) return true
    setInlineStatus(
      status,
      'error',
      'Enable SSH workspaces in Settings before adding or importing an SSH machine.',
    )
    return false
  }
  cancel.addEventListener('click', close)
  root.addEventListener('submit', (event) => {
    event.preventDefault()
    void (async (): Promise<void> => {
      busy(true)
      try {
        const existing = parseSshWorkspaceHosts(await api.settings.get('sshWorkspaceHosts'))
        const parsed = hostFields.parse(existing)
        if (!parsed.ok) {
          setInlineStatus(status, 'error', parsed.error)
          return
        }
        if (!(await requireSshEnabled())) return
        await api.settings.set('sshWorkspaceHosts', upsertHost(existing, parsed.host))
        close()
        await onSaved(parsed.host.id)
      } catch (error) {
        setInlineStatus(status, 'error', ipcErrorMessage(error, 'Could not save the SSH machine.'))
      } finally {
        busy(false)
      }
    })()
  })
  configSelect.addEventListener('change', () => {
    const chosen = configHosts.find((host) => host.host === configSelect.value)
    if (!chosen) return
    void (async (): Promise<void> => {
      busy(true)
      try {
        if (!(await requireSshEnabled())) return
        const existing = parseSshWorkspaceHosts(await api.settings.get('sshWorkspaceHosts'))
        const saved = saveSshConfigHost(existing, chosen)
        await api.settings.set('sshWorkspaceHosts', saved.hosts)
        close()
        await onSaved(saved.hostId)
      } catch (error) {
        setInlineStatus(status, 'error', ipcErrorMessage(error, 'Could not save the SSH machine.'))
      } finally {
        busy(false)
      }
    })()
  })
  return { root, open, close }
}
