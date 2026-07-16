import { el, clear } from '../dom/helpers.ts'
import { showToast } from './toast.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshRemoteDirEntry, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

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
 * Minimal remote directory browser: pick a configured SSH host, browse folders
 * over `ssh-workspace:listDirectory`, then register + return the chosen path.
 */
export function openRemoteFolderDialog(api: ApiClient): Promise<RemoteFolderPick | null> {
  const dialog = ensureDialog()
  clear(dialog)

  const hostSelect = el('select', { class: 'remote-folder-host', 'aria-label': 'SSH host' })
  const pathLabel = el('code', { class: 'remote-folder-path' }, '/')
  const list = el('div', { class: 'remote-folder-list', role: 'listbox' })
  const status = el('p', { class: 'remote-folder-status field-hint' })
  const upBtn = el('button', { type: 'button', class: 'remote-folder-up' }, 'Up')
  const openBtn = el('button', { type: 'button', class: 'remote-folder-open primary' }, 'Open')
  const cancelBtn = el('button', { type: 'button', class: 'remote-folder-cancel' }, 'Cancel')

  dialog.append(
    el('h3', {}, 'Open remote folder'),
    el('p', { class: 'field-hint' }, 'Choose an SSH host and folder on the remote machine.'),
    el('label', {}, 'Host ', hostSelect),
    el('div', { class: 'remote-folder-toolbar' }, upBtn, pathLabel),
    list,
    status,
    el('div', { class: 'remote-folder-actions' }, cancelBtn, openBtn),
  )

  let hosts: SshWorkspaceHost[] = []
  let currentHostId = ''
  let currentPath = '/'
  let loading = false

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

    async function loadHosts(): Promise<void> {
      status.textContent = 'Loading hosts…'
      try {
        hosts = await api.sshWorkspace.listHosts()
        clear(hostSelect)
        for (const host of hosts) {
          hostSelect.append(el('option', { value: host.id }, `${host.label} (${host.host})`))
        }
        if (hosts.length === 0) {
          status.textContent = 'Add SSH hosts in Settings first.'
          openBtn.disabled = true
          upBtn.disabled = true
          return
        }
        currentHostId = hosts[0]?.id ?? ''
        hostSelect.value = currentHostId
        await browse('/')
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err)
      }
    }

    async function browse(path: string): Promise<void> {
      if (!currentHostId || loading) return
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
        if (hosts.length > 0 && currentHostId) {
          upBtn.disabled = currentPath === '/'
          openBtn.disabled = false
        }
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
