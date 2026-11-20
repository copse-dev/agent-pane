import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { el, clear } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import {
  importSshConfigHosts,
  parseSshWorkspaceHosts,
  removeHost,
  upsertHost,
} from './ssh-host-helpers.ts'
import { createSshHostFields } from './ssh-host-fields.ts'
import { describeSshMachine, machineSummaryElement } from './machine-capabilities.ts'
import { sanitizeTrustedSshHosts } from '@shared/trusted-ssh-hosts.ts'

export { slugifyHostId, upsertHost, removeHost } from './ssh-host-helpers.ts'

export interface SshWorkspaceSection {
  root: HTMLFieldSetElement
  refresh: (signal?: AbortSignal) => Promise<void>
  /** Bring the empty host form into view, ready for a new machine. */
  addHost: () => void
  load: (snapshot: SettingsSnapshot) => void
  collect: (data: FormData, dirty: ReadonlySet<string>) => SettingsUpdate
}

export interface SshWorkspaceSectionOptions {
  /** Fired after a live-persisted setting change (enable toggle, host key policy). */
  onChanged?: () => void
  deferOrdinaryWrites?: boolean
  /**
   * Where the saved hosts are listed. Settings passes the shared Machines list,
   * so each machine appears once; without it the section lists them itself.
   */
  hostList?: HTMLElement
}

export function createSshWorkspaceSection(
  api: ApiClient,
  opts: SshWorkspaceSectionOptions = {},
): SshWorkspaceSection {
  const hostList = opts.hostList ?? el('div', { class: 'ssh-host-list' })
  const status = el('span', { class: 'ssh-host-status' })
  const enabledInput = el('input', { type: 'checkbox', name: 'sshWorkspaceEnabled' })
  const strictSelect = el('select', { name: 'sshStrictHostKeys' })
  strictSelect.append(
    el('option', { value: 'accept-new' }, 'Accept new host keys (recommended)'),
    el('option', { value: 'strict' }, 'Strict: reject unknown host keys'),
  )

  const hostFields = createSshHostFields()

  const form = el(
    'div',
    { class: 'ssh-host-form' },
    ...hostFields.fields,
    el(
      'div',
      { class: 'provider-actions' },
      el('button', { type: 'button', class: 'ui-btn ui-btn-primary ssh-host-save' }, 'Save host'),
      el('button', { type: 'button', class: 'ui-btn ui-btn-secondary ssh-host-clear' }, 'Clear'),
    ),
  )

  async function persistHosts(next: SshWorkspaceHost[]): Promise<void> {
    await api.settings.set('sshWorkspaceHosts', next)
    await renderHosts()
    opts.onChanged?.()
  }

  function clearDraft(): void {
    hostFields.reset()
  }

  async function renderHosts(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    clear(hostList)
    const [rawHosts, credentialHostIds, states, agentsOnRemote, desktop, trusted] =
      await Promise.all([
        api.settings.get('sshWorkspaceHosts'),
        api.sshWorkspace.listCredentialHostIds(),
        api.sshWorkspace.getStates().catch(() => []),
        api.settings.get('acpOverSshEnabled'),
        api.settings.get('vncEnabled'),
        api.settings.get('trustedSshHosts'),
      ])
    if (signal?.aborted) return
    const list = parseSshWorkspaceHosts(rawHosts)
    const credentialHosts = new Set(credentialHostIds)
    const context = {
      states,
      agentsOnRemote: agentsOnRemote === true,
      desktop: desktop === true,
      trustedHosts: sanitizeTrustedSshHosts(trusted),
    }
    if (list.length === 0) {
      hostList.append(
        el(
          'p',
          { class: 'field-hint ssh-host-empty' },
          'No SSH machines yet. Add one below, or open a remote project.',
        ),
      )
      return
    }
    for (const host of list) {
      const row = el('div', { class: 'ssh-host-row' })
      const target = host.user ? `${host.user}@${host.host}` : host.host
      const hasSavedAuthentication = credentialHosts.has(host.id)
      const summary = el(
        'div',
        { class: 'ssh-host-summary' },
        el('div', {}, el('strong', {}, host.label), `: ${target}`),
        machineSummaryElement(describeSshMachine(host, context)),
        el(
          'div',
          {
            class: hasSavedAuthentication ? 'ssh-host-auth ssh-host-auth-saved' : 'ssh-host-auth',
          },
          hasSavedAuthentication
            ? 'Authentication encrypted by OS keychain'
            : 'Authentication will be requested when you connect',
        ),
      )
      const actions = el(
        'div',
        { class: 'ssh-host-row-actions' },
        el('button', { type: 'button', class: 'ssh-host-edit' }, 'Edit'),
      )
      if (hasSavedAuthentication) {
        const forget = el(
          'button',
          { type: 'button', class: 'ssh-host-forget-auth' },
          'Forget authentication',
        )
        forget.addEventListener('click', () => {
          void api.sshWorkspace.forgetCredentials(host.id).then(() => {
            setInlineStatus(status, 'ok', `Forgot authentication for “${host.label}”.`)
            return renderHosts()
          })
        })
        actions.append(forget)
      }
      actions.append(el('button', { type: 'button', class: 'ssh-host-delete' }, 'Remove'))
      row.append(summary, actions)
      row.querySelector('.ssh-host-edit')?.addEventListener('click', () => {
        hostFields.edit(host)
      })
      row.querySelector('.ssh-host-delete')?.addEventListener('click', () => {
        void api.sshWorkspace
          .forgetCredentials(host.id)
          .then(() => persistHosts(removeHost(list, host.id)))
      })
      hostList.append(row)
    }
  }

  form.querySelector('.ssh-host-save')?.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const existing = parseSshWorkspaceHosts(await api.settings.get('sshWorkspaceHosts'))
      const parsed = hostFields.parse(existing)
      if (!parsed.ok) {
        setInlineStatus(status, 'error', parsed.error)
        return
      }
      await persistHosts(upsertHost(existing, parsed.host))
      setInlineStatus(status, 'ok', `Saved host “${parsed.host.label}”.`)
      clearDraft()
    })()
  })
  form.querySelector('.ssh-host-clear')?.addEventListener('click', () => {
    clearDraft()
    status.replaceChildren()
  })

  enabledInput.addEventListener('change', () => {
    if (opts.deferOrdinaryWrites) return
    void api.settings.set('sshWorkspaceEnabled', enabledInput.checked).then(() => {
      opts.onChanged?.()
    })
  })
  strictSelect.addEventListener('change', () => {
    if (opts.deferOrdinaryWrites) return
    void api.settings.set('sshStrictHostKeys', strictSelect.value).then(() => {
      opts.onChanged?.()
    })
  })

  function load(snapshot: SettingsSnapshot): void {
    enabledInput.checked = snapshot.sshWorkspaceEnabled === true
    strictSelect.value = snapshot.sshStrictHostKeys === 'strict' ? 'strict' : 'accept-new'
  }
  async function refresh(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    if (!opts.deferOrdinaryWrites) {
      const enabled = await api.settings.get('sshWorkspaceEnabled')
      const strict = await api.settings.get('sshStrictHostKeys')
      if (signal?.aborted) return
      enabledInput.checked = enabled === true
      strictSelect.value = strict === 'strict' ? 'strict' : 'accept-new'
    }
    await renderHosts(signal)
  }

  const importBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary ssh-import-config' },
    'Import from ~/.ssh/config',
  )
  importBtn.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const aliases = await api.sshWorkspace.listConfigAliases()
      if (aliases.length === 0) {
        setInlineStatus(status, 'error', 'No Host entries found in ~/.ssh/config.')
        return
      }
      const raw = await api.settings.get('sshWorkspaceHosts')
      const existing = parseSshWorkspaceHosts(raw)
      const imported = importSshConfigHosts(existing, aliases)
      await persistHosts(imported.hosts)
      if (imported.importedHostIds.length === 0) {
        setInlineStatus(status, 'ok', 'All SSH config aliases are already imported.')
        return
      }
      setInlineStatus(
        status,
        'ok',
        `Imported ${String(imported.importedHostIds.length)} alias(es) from SSH config.`,
      )
    })()
  })

  const root = el(
    'fieldset',
    {},
    el('legend', {}, 'SSH workspaces'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Run shell, git, search, and file tools on a remote Linux host over SSH. Enable the feature below, add hosts here or in the ',
      el('strong', {}, 'Open remote folder'),
      ' dialog, then open a remote project from the projects panel.',
      ' Passwords and key passphrases can be encrypted with the OS keychain and managed per host.',
    ),
    el('label', { class: 'checkbox-label' }, enabledInput, ' Enable SSH workspaces (experimental)'),
    el('label', {}, 'Host key policy ', strictSelect),
    // A shared list lives elsewhere (Settings → Machines "Your machines");
    // appending it here would move it out of that list.
    ...(opts.hostList ? [] : [hostList]),
    importBtn,
    form,
    status,
  )

  return {
    root,
    refresh,
    addHost: (): void => {
      hostFields.reset()
      status.replaceChildren()
      form.scrollIntoView({ block: 'center' })
      hostFields.focus()
    },
    load,
    collect: (data, dirty): SettingsUpdate => ({
      ...(dirty.has('sshWorkspaceEnabled')
        ? { sshWorkspaceEnabled: data.has('sshWorkspaceEnabled') }
        : {}),
      ...(dirty.has('sshStrictHostKeys')
        ? { sshStrictHostKeys: strictSelect.value === 'strict' ? 'strict' : 'accept-new' }
        : {}),
    }),
  }
}
