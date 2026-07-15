import { el, clear } from '../dom/helpers.ts'
import { showToast } from './toast.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshRemoteDirEntry, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import {
  emptySshHostDraft,
  parseSshHostDraft,
  slugifyHostId,
  upsertHost,
  type SshHostDraft,
} from './setup/ssh-host-helpers.ts'

export interface RemoteFolderPick {
  hostId: string
  path: string
}

let dialogEl: HTMLDialogElement | null = null

function ensureDialog(): HTMLDialogElement {
  if (dialogEl) return dialogEl
  dialogEl = el('dialog', { id: 'remote-folder-dialog', class: 'remote-folder-dialog' })
  document.body.append(dialogEl)
  return dialogEl
}

function parentPath(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

/**
 * Minimal remote directory browser: pick or add an SSH host, browse folders
 * over `ssh-workspace:listDirectory`, then register + return the chosen path.
 */
export function openRemoteFolderDialog(api: ApiClient): Promise<RemoteFolderPick | null> {
  const dialog = ensureDialog()
  clear(dialog)

  const hostSelect = el('select', { class: 'remote-folder-host', 'aria-label': 'SSH host' })
  const addHostBtn = el(
    'button',
    { type: 'button', class: 'remote-folder-add-host-btn' },
    'Add host',
  )
  const pathLabel = el('code', { class: 'remote-folder-path' }, '/')
  const list = el('div', { class: 'remote-folder-list', role: 'listbox' })
  const status = el('p', { class: 'remote-folder-status field-hint' })
  const upBtn = el('button', { type: 'button', class: 'remote-folder-up' }, 'Up')
  const openBtn = el('button', { type: 'button', class: 'remote-folder-open primary' }, 'Open')
  const cancelBtn = el('button', { type: 'button', class: 'remote-folder-cancel' }, 'Cancel')

  const draft: SshHostDraft = emptySshHostDraft()
  const idInput = el('input', {
    name: 'remoteFolderHostId',
    class: 'remote-folder-host-id',
    placeholder: 'my-server',
    'aria-label': 'Host id',
  })
  const labelInput = el('input', {
    name: 'remoteFolderHostLabel',
    class: 'remote-folder-host-label',
    placeholder: 'Production',
    'aria-label': 'Host label',
  })
  const hostInput = el('input', {
    name: 'remoteFolderHostHost',
    class: 'remote-folder-host-host',
    placeholder: 'example.com or ~/.ssh/config alias',
    'aria-label': 'Hostname',
  })
  const userInput = el('input', {
    name: 'remoteFolderHostUser',
    class: 'remote-folder-host-user',
    placeholder: 'ubuntu',
    'aria-label': 'SSH user',
  })
  const portInput = el('input', {
    name: 'remoteFolderHostPort',
    class: 'remote-folder-host-port',
    placeholder: '22',
    inputmode: 'numeric',
    'aria-label': 'SSH port',
  })
  const identityInput = el('input', {
    name: 'remoteFolderHostIdentity',
    class: 'remote-folder-host-identity',
    placeholder: '~/.ssh/id_ed25519',
    'aria-label': 'Identity file',
  })
  const saveHostBtn = el(
    'button',
    { type: 'button', class: 'remote-folder-save-host primary' },
    'Save host',
  )
  const cancelAddBtn = el('button', { type: 'button', class: 'remote-folder-cancel-add' }, 'Cancel')
  const importBtn = el(
    'button',
    { type: 'button', class: 'remote-folder-import-config' },
    'Import from ~/.ssh/config',
  )
  const addHostForm = el(
    'div',
    { class: 'remote-folder-add-host-form ssh-host-form', hidden: true },
    el('p', { class: 'field-hint' }, 'Add an SSH host to browse and open a remote folder.'),
    el('label', {}, 'Id ', idInput),
    el('label', {}, 'Label ', labelInput),
    el('label', {}, 'Host ', hostInput),
    el('label', {}, 'User ', userInput),
    el('label', {}, 'Port ', portInput),
    el('label', {}, 'Identity file ', identityInput),
    el(
      'div',
      { class: 'remote-folder-add-host-actions provider-actions' },
      importBtn,
      cancelAddBtn,
      saveHostBtn,
    ),
  )

  const browsePanel = el(
    'div',
    { class: 'remote-folder-browse' },
    el('div', { class: 'remote-folder-toolbar' }, upBtn, pathLabel),
    list,
  )

  dialog.append(
    el('h3', {}, 'Open remote folder'),
    el('p', { class: 'field-hint' }, 'Choose an SSH host and folder on the remote machine.'),
    el(
      'div',
      { class: 'remote-folder-host-row' },
      el('label', { class: 'remote-folder-host-label-wrap' }, 'Host ', hostSelect),
      addHostBtn,
    ),
    addHostForm,
    browsePanel,
    status,
    el('div', { class: 'remote-folder-actions' }, cancelBtn, openBtn),
  )

  let hosts: SshWorkspaceHost[] = []
  let currentHostId = ''
  let currentPath = '/'
  let loading = false
  let addingHost = false

  function setAddingHost(next: boolean): void {
    addingHost = next
    addHostForm.hidden = !next
    addHostBtn.hidden = next
    browsePanel.hidden = next
    openBtn.hidden = next
    if (next) {
      Object.assign(draft, emptySshHostDraft())
      idInput.value = ''
      labelInput.value = ''
      hostInput.value = ''
      userInput.value = ''
      portInput.value = ''
      identityInput.value = ''
      idInput.disabled = false
      status.textContent = ''
      labelInput.focus()
    }
  }

  function fillHostSelect(selectedId?: string): void {
    clear(hostSelect)
    for (const host of hosts) {
      hostSelect.append(el('option', { value: host.id }, `${host.label} (${host.host})`))
    }
    if (hosts.length === 0) {
      hostSelect.append(el('option', { value: '', disabled: true }, 'No hosts yet'))
      hostSelect.disabled = true
      currentHostId = ''
      return
    }
    hostSelect.disabled = false
    const preferred =
      (selectedId && hosts.some((h) => h.id === selectedId) ? selectedId : undefined) ??
      hosts[0]?.id ??
      ''
    currentHostId = preferred
    hostSelect.value = preferred
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: RemoteFolderPick | null): void => {
      if (settled) return
      settled = true
      dialog.close()
      resolve(value)
    }

    dialog.addEventListener('cancel', () => {
      finish(null)
    })

    cancelBtn.addEventListener('click', () => {
      finish(null)
    })

    addHostBtn.addEventListener('click', () => {
      setAddingHost(true)
    })

    cancelAddBtn.addEventListener('click', () => {
      if (hosts.length === 0) {
        finish(null)
        return
      }
      setAddingHost(false)
      status.textContent = ''
    })

    labelInput.addEventListener('input', () => {
      draft.label = labelInput.value
      if (!idInput.value && !idInput.disabled) {
        idInput.value = slugifyHostId(draft.label)
        draft.id = idInput.value
      }
    })
    idInput.addEventListener('input', () => {
      draft.id = idInput.value
    })
    hostInput.addEventListener('input', () => {
      draft.host = hostInput.value
    })
    userInput.addEventListener('input', () => {
      draft.user = userInput.value
    })
    portInput.addEventListener('input', () => {
      draft.port = portInput.value
    })
    identityInput.addEventListener('input', () => {
      draft.identityFile = identityInput.value
    })

    async function persistAndSelect(host: SshWorkspaceHost): Promise<void> {
      const raw = await api.settings.get('sshWorkspaceHosts')
      const existing = Array.isArray(raw) ? (raw as SshWorkspaceHost[]) : []
      await api.settings.set('sshWorkspaceHosts', upsertHost(existing, host))
      hosts = await api.sshWorkspace.listHosts()
      fillHostSelect(host.id)
      setAddingHost(false)
      status.textContent = `Saved host “${host.label}”.`
      await browse('/')
    }

    saveHostBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        draft.label = labelInput.value
        draft.id = idInput.value
        draft.host = hostInput.value
        draft.user = userInput.value
        draft.port = portInput.value
        draft.identityFile = identityInput.value
        const parsed = parseSshHostDraft(draft)
        if (!parsed.ok) {
          status.textContent = parsed.error
          return
        }
        try {
          await persistAndSelect(parsed.host)
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : String(err)
          showToast(status.textContent, { variant: 'error' })
        }
      })()
    })

    importBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        try {
          const aliases = await api.sshWorkspace.listConfigAliases()
          if (aliases.length === 0) {
            status.textContent = 'No Host entries found in ~/.ssh/config.'
            return
          }
          const raw = await api.settings.get('sshWorkspaceHosts')
          const existing = Array.isArray(raw) ? (raw as SshWorkspaceHost[]) : []
          let next = existing
          for (const alias of aliases) {
            if (next.some((h) => h.id === alias.id)) continue
            next = upsertHost(next, alias)
          }
          await api.settings.set('sshWorkspaceHosts', next)
          hosts = await api.sshWorkspace.listHosts()
          fillHostSelect(aliases[0]?.id)
          setAddingHost(false)
          status.textContent = `Imported ${String(aliases.length)} alias(es) from SSH config.`
          if (currentHostId) await browse('/')
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : String(err)
          showToast(status.textContent, { variant: 'error' })
        }
      })()
    })

    async function loadHosts(): Promise<void> {
      status.textContent = 'Loading hosts…'
      try {
        hosts = await api.sshWorkspace.listHosts()
        fillHostSelect()
        if (hosts.length === 0) {
          openBtn.disabled = true
          upBtn.disabled = true
          setAddingHost(true)
          status.textContent = 'Add a host below to continue.'
          return
        }
        setAddingHost(false)
        await browse('/')
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err)
      }
    }

    async function browse(path: string): Promise<void> {
      if (!currentHostId || loading || addingHost) return
      loading = true
      openBtn.disabled = true
      upBtn.disabled = true
      status.textContent = 'Connecting…'
      clear(list)
      try {
        await api.sshWorkspace.connect(currentHostId)
        currentPath = path
        pathLabel.textContent = currentPath
        const entries: SshRemoteDirEntry[] = await api.sshWorkspace.listDirectory(
          currentHostId,
          currentPath,
        )
        status.textContent =
          entries.length === 0 ? 'No subfolders here — open this folder or go up.' : ''
        for (const entry of entries) {
          const row = el(
            'button',
            {
              type: 'button',
              class: 'remote-folder-entry',
              role: 'option',
            },
            entry.name,
          )
          row.addEventListener('click', () => {
            void browse(entry.path)
          })
          list.append(row)
        }
        upBtn.disabled = currentPath === '/'
        openBtn.disabled = false
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err)
        showToast(status.textContent, { variant: 'error' })
      } finally {
        loading = false
      }
    }

    hostSelect.addEventListener('change', () => {
      currentHostId = hostSelect.value
      void browse('/')
    })

    upBtn.addEventListener('click', () => {
      void browse(parentPath(currentPath))
    })

    openBtn.addEventListener('click', () => {
      if (!currentHostId) return
      finish({ hostId: currentHostId, path: currentPath })
    })

    void loadHosts()
    dialog.showModal()
  })
}
