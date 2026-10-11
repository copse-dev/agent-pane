import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { setInlineStatus } from '../dom/inline-status.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import {
  importSshConfigHosts,
  parseSshHostDraft,
  parseSshWorkspaceHosts,
  slugifyHostId,
  upsertHost,
} from './setup/ssh-host-helpers.ts'

export function createVncSshHostForm(
  api: ApiClient,
  onSaved: (hostId: string) => Promise<void>,
  onClose: () => void,
): { root: HTMLElement; open(): void; close(): void } {
  const id = el('input', { type: 'text', 'aria-label': 'SSH host id', placeholder: 'my-server' })
  const label = el('input', {
    type: 'text',
    'aria-label': 'SSH host label',
    placeholder: 'Production',
  })
  const host = el('input', {
    type: 'text',
    'aria-label': 'SSH hostname',
    placeholder: 'example.com or ~/.ssh/config alias',
  })
  const user = el('input', { type: 'text', 'aria-label': 'SSH user', placeholder: 'ubuntu' })
  const port = el('input', {
    type: 'text',
    inputmode: 'numeric',
    'aria-label': 'SSH port',
    placeholder: '22',
  })
  const identityFile = el('input', {
    type: 'text',
    'aria-label': 'SSH identity file',
    placeholder: '~/.ssh/id_ed25519',
  })
  const status = el('p', { class: 'vnc-ssh-host-status', role: 'status' })
  const save = el('button', { type: 'submit', class: 'ui-btn ui-btn-primary' }, 'Save SSH machine')
  const cancel = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Cancel')
  const importButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost' },
    'Import SSH config',
  )
  const root = el(
    'form',
    { class: 'vnc-ssh-host-form', hidden: true, 'aria-label': 'Add SSH machine' },
    el('p', { class: 'vnc-ssh-host-hint' }, 'Use an SSH key to secure the desktop connection.'),
    el('label', { class: 'vnc-field-label' }, 'Id', id),
    el('label', { class: 'vnc-field-label' }, 'Label', label),
    el('label', { class: 'vnc-field-label' }, 'Host', host),
    el('label', { class: 'vnc-field-label' }, 'User', user),
    el('label', { class: 'vnc-field-label' }, 'Port', port),
    el('label', { class: 'vnc-field-label' }, 'Identity file', identityFile),
    status,
    el('div', { class: 'vnc-ssh-host-actions' }, importButton, cancel, save),
  )
  let idTouched = false
  label.addEventListener('input', () => {
    if (!idTouched) id.value = slugifyHostId(label.value)
  })
  id.addEventListener('input', () => {
    idTouched = true
  })
  function close(): void {
    root.hidden = true
    status.textContent = ''
    onClose()
  }
  function open(): void {
    root.reset()
    idTouched = false
    status.textContent = ''
    root.hidden = false
    label.focus()
  }
  function busy(value: boolean): void {
    save.disabled = value
    importButton.disabled = value
    cancel.disabled = value
  }
  cancel.addEventListener('click', close)
  root.addEventListener('submit', (event) => {
    event.preventDefault()
    const parsed = parseSshHostDraft({
      id: id.value,
      label: label.value,
      host: host.value,
      user: user.value,
      port: port.value,
      identityFile: identityFile.value,
      forwardAgent: false,
    })
    if (!parsed.ok) {
      setInlineStatus(status, 'error', parsed.error)
      return
    }
    void (async (): Promise<void> => {
      busy(true)
      try {
        const existing = parseSshWorkspaceHosts(await api.settings.get('sshWorkspaceHosts'))
        if (existing.some((item) => item.id === parsed.host.id)) {
          setInlineStatus(status, 'error', 'A machine with this id already exists.')
          return
        }
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
  importButton.addEventListener('click', () => {
    void (async (): Promise<void> => {
      busy(true)
      try {
        const aliases = await api.sshWorkspace.listConfigAliases()
        if (aliases.length === 0) {
          setInlineStatus(status, 'error', 'No Host entries found in ~/.ssh/config.')
          return
        }
        const existing = parseSshWorkspaceHosts(await api.settings.get('sshWorkspaceHosts'))
        const imported = importSshConfigHosts(existing, aliases)
        await api.settings.set('sshWorkspaceHosts', imported.hosts)
        if (imported.firstAliasHostId) {
          close()
          await onSaved(imported.firstAliasHostId)
        }
      } catch (error) {
        setInlineStatus(status, 'error', ipcErrorMessage(error, 'Could not import SSH config.'))
      } finally {
        busy(false)
      }
    })()
  })
  return { root, open, close }
}
