import type { ApiClient } from '../../../preload/api.d.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { el, clear } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import {
  emptySshHostDraft,
  parseSshHostDraft,
  removeHost,
  slugifyHostId,
  upsertHost,
  type SshHostDraft,
} from './ssh-host-helpers.ts'

export { slugifyHostId, upsertHost, removeHost } from './ssh-host-helpers.ts'

export interface SshWorkspaceSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
}

export function createSshWorkspaceSection(api: ApiClient): SshWorkspaceSection {
  const hostList = el('div', { class: 'ssh-host-list' })
  const status = el('span', { class: 'ssh-host-status' })
  const enabledInput = el('input', { type: 'checkbox', name: 'sshWorkspaceEnabled' })
  const strictSelect = el('select', { name: 'sshStrictHostKeys' })
  strictSelect.append(
    el('option', { value: 'accept-new' }, 'Accept new host keys (recommended)'),
    el('option', { value: 'strict' }, 'Strict — reject unknown host keys'),
  )

  const draft: SshHostDraft = emptySshHostDraft()

  const idInput = el('input', { name: 'sshHostId', placeholder: 'my-server' })
  const labelInput = el('input', { name: 'sshHostLabel', placeholder: 'Production' })
  const hostInput = el('input', {
    name: 'sshHostHost',
    placeholder: 'example.com or ~/.ssh/config alias',
  })
  const userInput = el('input', { name: 'sshHostUser', placeholder: 'ubuntu' })
  const portInput = el('input', { name: 'sshHostPort', placeholder: '22', inputmode: 'numeric' })
  const identityInput = el('input', {
    name: 'sshHostIdentity',
    placeholder: '~/.ssh/id_ed25519',
  })
  const forwardInput = el('input', { type: 'checkbox', name: 'sshHostForwardAgent' })

  const form = el(
    'div',
    { class: 'ssh-host-form' },
    el('label', {}, 'Id ', idInput),
    el('label', {}, 'Label ', labelInput),
    el('label', {}, 'Host ', hostInput),
    el('label', {}, 'User ', userInput),
    el('label', {}, 'Port ', portInput),
    el('label', {}, 'Identity file ', identityInput),
    el('label', { class: 'checkbox-label' }, forwardInput, ' Forward SSH agent'),
    el(
      'div',
      { class: 'provider-actions' },
      el('button', { type: 'button', class: 'ssh-host-save' }, 'Save host'),
      el('button', { type: 'button', class: 'ssh-host-clear' }, 'Clear'),
    ),
  )

  async function persistHosts(next: SshWorkspaceHost[]): Promise<void> {
    await api.settings.set('sshWorkspaceHosts', next)
    await renderHosts()
  }

  function clearDraft(): void {
    Object.assign(draft, emptySshHostDraft())
    idInput.value = ''
    labelInput.value = ''
    hostInput.value = ''
    userInput.value = ''
    portInput.value = ''
    identityInput.value = ''
    forwardInput.checked = false
    idInput.disabled = false
  }

  function fillDraft(host: SshWorkspaceHost): void {
    draft.id = host.id
    draft.label = host.label
    draft.host = host.host
    draft.user = host.user ?? ''
    draft.port = host.port !== undefined ? String(host.port) : ''
    draft.identityFile = host.identityFile ?? ''
    draft.forwardAgent = host.forwardAgent === true
    idInput.value = host.id
    labelInput.value = host.label
    hostInput.value = host.host
    userInput.value = draft.user
    portInput.value = draft.port
    identityInput.value = draft.identityFile
    forwardInput.checked = draft.forwardAgent
    idInput.disabled = true
  }

  async function renderHosts(): Promise<void> {
    clear(hostList)
    const hosts = (await api.settings.get('sshWorkspaceHosts')) as SshWorkspaceHost[] | null
    const list = Array.isArray(hosts) ? hosts : []
    if (list.length === 0) {
      hostList.append(el('p', { class: 'field-hint' }, 'No SSH hosts configured yet.'))
      return
    }
    for (const host of list) {
      const row = el('div', { class: 'ssh-host-row' })
      const target = host.user ? `${host.user}@${host.host}` : host.host
      row.append(
        el('div', { class: 'ssh-host-summary' }, el('strong', {}, host.label), ` — ${target}`),
        el(
          'div',
          { class: 'ssh-host-row-actions' },
          el('button', { type: 'button', class: 'ssh-host-edit' }, 'Edit'),
          el('button', { type: 'button', class: 'ssh-host-delete' }, 'Remove'),
        ),
      )
      row.querySelector('.ssh-host-edit')?.addEventListener('click', () => {
        fillDraft(host)
      })
      row.querySelector('.ssh-host-delete')?.addEventListener('click', () => {
        void persistHosts(removeHost(list, host.id))
      })
      hostList.append(row)
    }
  }

  idInput.addEventListener('input', () => {
    draft.id = idInput.value
  })
  labelInput.addEventListener('input', () => {
    draft.label = labelInput.value
    if (!idInput.value && !idInput.disabled) idInput.value = slugifyHostId(draft.label)
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
  forwardInput.addEventListener('change', () => {
    draft.forwardAgent = forwardInput.checked
  })

  form.querySelector('.ssh-host-save')?.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const parsed = parseSshHostDraft(draft)
      if (!parsed.ok) {
        setInlineStatus(status, 'error', parsed.error)
        return
      }
      const raw = await api.settings.get('sshWorkspaceHosts')
      const existing = Array.isArray(raw) ? (raw as SshWorkspaceHost[]) : []
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
    void api.settings.set('sshWorkspaceEnabled', enabledInput.checked)
  })
  strictSelect.addEventListener('change', () => {
    void api.settings.set('sshStrictHostKeys', strictSelect.value)
  })

  async function refresh(): Promise<void> {
    enabledInput.checked = (await api.settings.get('sshWorkspaceEnabled')) === true
    const strict = await api.settings.get('sshStrictHostKeys')
    strictSelect.value = strict === 'strict' ? 'strict' : 'accept-new'
    await renderHosts()
  }

  const importBtn = el(
    'button',
    { type: 'button', class: 'ssh-import-config' },
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
      const existing = Array.isArray(raw) ? (raw as SshWorkspaceHost[]) : []
      let next = existing
      for (const alias of aliases) {
        if (next.some((h) => h.id === alias.id)) continue
        next = upsertHost(next, alias)
      }
      await persistHosts(next)
      setInlineStatus(status, 'ok', `Imported ${String(aliases.length)} alias(es) from SSH config.`)
    })()
  })

  const root = el(
    'fieldset',
    {},
    el('legend', {}, 'SSH workspaces'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Run shell, git, search, and file tools on a remote Linux host over SSH. Add hosts here or in the ',
      el('strong', {}, 'Open remote folder'),
      ' dialog, enable the feature, then open a remote project from the projects panel.',
    ),
    el('label', { class: 'checkbox-label' }, enabledInput, ' Enable SSH workspaces (experimental)'),
    el('label', {}, 'Host key policy ', strictSelect),
    hostList,
    importBtn,
    form,
    status,
  )

  return { root, refresh }
}
