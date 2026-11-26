import { lazyBodyDialog } from './dialog-shell.ts'
import { el, clear } from '../dom/helpers.ts'
import { showToast } from './toast.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshRemoteDirEntry, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import {
  parseSshWorkspaceHosts,
  saveSshConfigHost,
  unsavedSshConfigHosts,
  upsertHost,
} from './setup/ssh-host-helpers.ts'
import { createSshHostFields } from './setup/ssh-host-fields.ts'
import { createSshWorkspaceConsent } from './ssh-workspace-consent.ts'
import { isSshWorkspaceEnabled } from '../controller/ssh-workspace-ui.ts'
import {
  fillRemotePathBreadcrumbs,
  initialRemoteBrowsePath,
  parentRemotePath,
} from './remote-folder-path.ts'
import { arrowLeftIcon } from '../dom/icons.ts'
import { setInlineStatus } from '../dom/inline-status.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'

export interface RemoteFolderPick {
  hostId: string
  path: string
}

export interface RemoteFolderDialogOptions {
  /** Projects already open, so a host's browser can start beside the last one. */
  projects?: ReadonlyArray<{ path: string; sshHost?: string }>
}

/** Picker values for `~/.ssh/config` hosts not saved yet; saved host ids never contain `:`. */
const SSH_CONFIG_OPTION = 'ssh-config:'

const ensureDialog = lazyBodyDialog('remote-folder-dialog', 'remote-folder-dialog')

/**
 * Minimal remote directory browser: pick or add an SSH host, browse folders
 * over `ssh-workspace:list-directory`, then register + return the chosen path.
 * Each host opens beside its last project, or in its home directory.
 */
export function openRemoteFolderDialog(
  api: ApiClient,
  options: RemoteFolderDialogOptions = {},
): Promise<RemoteFolderPick | null> {
  const projects = options.projects ?? []
  const dialog = ensureDialog()
  clear(dialog)

  const hostSelect = el('select', { class: 'remote-folder-host', 'aria-label': 'SSH host' })
  const addHostBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary remote-folder-add-host-btn' },
    'Add host',
  )
  const breadcrumbs = el('nav', {
    class: 'remote-folder-breadcrumbs',
    'aria-label': 'Remote path',
  })
  const list = el('div', { class: 'remote-folder-list', role: 'listbox' })
  const status = el('p', { class: 'remote-folder-status field-hint' })
  const upBtn = el(
    'button',
    { type: 'button', class: 'remote-folder-up', 'aria-label': 'Go up one directory' },
    arrowLeftIcon('ui-icon ui-icon-sm'),
    'Up',
  )
  const openBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary remote-folder-open' },
    'Open',
  )
  const cancelBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary remote-folder-cancel' },
    'Cancel',
  )

  const hostFields = createSshHostFields()
  const saveHostBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary remote-folder-save-host' },
    'Save host',
  )
  const cancelAddBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary remote-folder-cancel-add' },
    'Cancel',
  )
  // The form's own lead-in, above its first field. With no hosts saved yet it
  // also says that this is the next step, rather than leaving that to the status
  // line under the form it refers to.
  const addHostHint = el(
    'p',
    { class: 'field-hint remote-folder-add-host-hint' },
    'Add an SSH host to browse and open a remote folder.',
  )
  const addHostForm = el(
    'div',
    { class: 'remote-folder-add-host-form ssh-host-form', hidden: true },
    addHostHint,
    ...hostFields.fields,
    el(
      'div',
      { class: 'remote-folder-add-host-actions provider-actions' },
      cancelAddBtn,
      saveHostBtn,
    ),
  )

  const browsePanel = el(
    'div',
    { class: 'remote-folder-browse' },
    el('div', { class: 'remote-folder-toolbar' }, upBtn, breadcrumbs),
    list,
  )

  // Everything below the heading, hidden while the turn-on step is showing.
  const picker = el(
    'div',
    { class: 'remote-folder-picker' },
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
  dialog.append(el('h3', {}, 'Open remote folder'), picker)

  let hosts: SshWorkspaceHost[] = []
  /** `~/.ssh/config` hosts not saved yet, offered in the picker below the saved ones. */
  let configHosts: SshWorkspaceHost[] = []
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
      hostFields.reset()
      addHostHint.textContent =
        hosts.length > 0
          ? 'Add an SSH host to browse and open a remote folder.'
          : configHosts.length > 0
            ? 'No SSH hosts saved yet. Choose one from ~/.ssh/config above, or add one here.'
            : 'No SSH hosts yet. Add one to browse and open a remote folder.'
      status.textContent = ''
      hostFields.focus()
    }
  }

  function fillHostSelect(selectedId?: string): void {
    clear(hostSelect)
    for (const host of hosts) {
      hostSelect.append(el('option', { value: host.id }, `${host.label} (${host.host})`))
    }
    if (configHosts.length > 0) {
      hostSelect.append(
        el(
          'optgroup',
          { label: 'In ~/.ssh/config' },
          ...configHosts.map((host) =>
            el('option', { value: `${SSH_CONFIG_OPTION}${host.host}` }, host.host),
          ),
        ),
      )
    }
    if (hosts.length === 0) {
      // Selected as well as disabled: a select whose only option is disabled
      // selects nothing and paints an empty box.
      hostSelect.prepend(
        el(
          'option',
          { value: '', disabled: true, selected: true },
          configHosts.length > 0 ? 'Choose a host' : 'No hosts yet',
        ),
      )
      hostSelect.disabled = configHosts.length === 0
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

    /** Saved hosts and the config hosts not saved yet, read afresh. */
    async function reloadHosts(): Promise<void> {
      const [saved, aliases] = await Promise.all([
        api.sshWorkspace.listHosts(),
        api.sshWorkspace.listConfigAliases().catch(() => []),
      ])
      hosts = saved
      configHosts = unsavedSshConfigHosts(saved, aliases)
    }

    async function persistAndSelect(hostId: string, label: string): Promise<void> {
      await reloadHosts()
      fillHostSelect(hostId)
      setAddingHost(false)
      status.textContent = `Saved host “${label}”.`
      await browseStart()
    }

    saveHostBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        try {
          const existing = parseSshWorkspaceHosts(await api.settings.get('sshWorkspaceHosts'))
          const parsed = hostFields.parse(existing)
          if (!parsed.ok) {
            setInlineStatus(status, 'error', parsed.error)
            return
          }
          await api.settings.set('sshWorkspaceHosts', upsertHost(existing, parsed.host))
          await persistAndSelect(parsed.host.id, parsed.host.label)
        } catch (err) {
          const message = ipcErrorMessage(err, 'Could not save the host.')
          setInlineStatus(status, 'error', message)
          showToast(message, { variant: 'error' })
        }
      })()
    })

    /** Save the `~/.ssh/config` host chosen in the picker, alone, then browse it. */
    async function chooseConfigHost(alias: string): Promise<void> {
      const chosen = configHosts.find((host) => host.host === alias)
      if (!chosen) return
      try {
        const existing = parseSshWorkspaceHosts(await api.settings.get('sshWorkspaceHosts'))
        const saved = saveSshConfigHost(existing, chosen)
        await api.settings.set('sshWorkspaceHosts', saved.hosts)
        await persistAndSelect(saved.hostId, chosen.label)
      } catch (err) {
        const message = ipcErrorMessage(err, 'Could not save the host.')
        setInlineStatus(status, 'error', message)
        showToast(message, { variant: 'error' })
      }
    }

    async function loadHosts(): Promise<void> {
      status.textContent = 'Loading hosts…'
      try {
        await reloadHosts()
        fillHostSelect()
        if (hosts.length === 0) {
          openBtn.disabled = true
          upBtn.disabled = true
          setAddingHost(true)
          return
        }
        setAddingHost(false)
        await browseStart()
      } catch (err) {
        setInlineStatus(status, 'error', ipcErrorMessage(err, 'Could not load SSH hosts.'))
      }
    }

    /** Counts listings, so one that a later host choice replaced draws nothing. */
    let listing = 0

    /** Open the chosen host where its user works rather than at `/`. */
    function browseStart(): Promise<void> {
      return browse(null)
    }

    function renderBreadcrumbs(path: string): void {
      fillRemotePathBreadcrumbs(breadcrumbs, path, (next) => {
        void browse(next)
      })
    }

    /**
     * List `path` on the current host. `null` lists the host's start folder
     * instead: beside its last project, else in the home directory that its
     * connect reports, else `/`. A start folder that no longer lists (a removed
     * project's parent) falls back to `/` on the same connection. A host choice
     * (`null`) replaces a listing still under way; anything else waits for it.
     */
    async function browse(path: string | null): Promise<void> {
      const hostId = currentHostId
      if (!hostId || addingHost || (loading && path !== null)) return
      const run = ++listing
      loading = true
      openBtn.disabled = true
      upBtn.disabled = true
      status.textContent = 'Connecting…'
      clear(list)
      let target = path ?? '/'
      try {
        const states = await api.sshWorkspace.connect(hostId)
        if (run !== listing) return
        if (path === null) {
          const home = states.find((state) => state.hostId === hostId)?.capabilities?.home
          target = initialRemoteBrowsePath(projects, hostId, home)
        }
        currentPath = target
        renderBreadcrumbs(currentPath)
        let entries: SshRemoteDirEntry[]
        try {
          entries = await api.sshWorkspace.listDirectory(hostId, target)
        } catch (err) {
          if (path !== null || target === '/' || run !== listing) throw err
          target = '/'
          currentPath = target
          renderBreadcrumbs(currentPath)
          entries = await api.sshWorkspace.listDirectory(hostId, target)
        }
        if (run !== listing) return
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
        if (run !== listing) return
        // Keep the attempted path visible so Up / breadcrumbs still work after errors.
        // Surface the error in the dialog status only — a global toast would fire on
        // every failed connect while browsing and trip e2e toast guards.
        currentPath = target
        renderBreadcrumbs(currentPath)
        setInlineStatus(status, 'error', ipcErrorMessage(err, 'Could not reach the host.'))
      } finally {
        if (run === listing) {
          loading = false
          if (hosts.length > 0 && currentHostId) {
            upBtn.disabled = currentPath === '/'
            openBtn.disabled = false
          }
        }
      }
    }

    hostSelect.addEventListener('change', () => {
      const value = hostSelect.value
      if (value.startsWith(SSH_CONFIG_OPTION)) {
        void chooseConfigHost(value.slice(SSH_CONFIG_OPTION.length))
        return
      }
      currentHostId = value
      void browseStart()
    })

    upBtn.addEventListener('click', () => {
      void browse(parentRemotePath(currentPath))
    })

    openBtn.addEventListener('click', () => {
      if (!currentHostId) return
      finish({ hostId: currentHostId, path: currentPath })
    })

    // With SSH workspaces off, say what turning them on means before anything
    // connects. Declining closes the dialog and leaves the setting off.
    void isSshWorkspaceEnabled(api).then((enabled) => {
      if (enabled) {
        void loadHosts()
        return
      }
      picker.hidden = true
      const consent = createSshWorkspaceConsent(api, {
        onEnabled: async () => {
          consent.root.remove()
          picker.hidden = false
          await loadHosts()
        },
        onCancel: () => {
          finish(null)
        },
      })
      dialog.append(consent.root)
    })
    dialog.showModal()
  })
}
