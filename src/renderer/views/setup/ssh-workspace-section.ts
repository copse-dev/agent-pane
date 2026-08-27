import type { ApiClient } from '../../../preload/api.d.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { el, clear } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import {
  emptySshHostDraft,
  parseSshHostDraft,
  parseSshWorkspaceHosts,
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

export interface SshWorkspaceSectionOptions {
  /** Fired after a live-persisted setting change (enable toggle, host key policy). */
  onChanged?: () => void
}

export function createSshWorkspaceSection(
  api: ApiClient,
  opts: SshWorkspaceSectionOptions = {},
): SshWorkspaceSection {
  const hostList = el('div', { class: 'ssh-host-list' })
  const status = el('span', { class: 'ssh-host-status' })
  const enabledInput = el('input', { type: 'checkbox', name: 'sshWorkspaceEnabled' })
  const strictSelect = el('select', { name: 'sshStrictHostKeys' })
  strictSelect.append(
    el('option', { value: 'accept-new' }, 'Accept new host keys (recommended)'),
    el('option', { value: 'strict' }, 'Strict: reject unknown host keys'),
  )

  const draft: SshHostDraft = emptySshHostDraft()
  let idTouched = false

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
    opts.onChanged?.()
  }

  function clearDraft(): void {
    Object.assign(draft, emptySshHostDraft())
    idTouched = false
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
    idTouched = true
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
    const [rawHosts, credentialHostIds] = await Promise.all([
      api.settings.get('sshWorkspaceHosts'),
      api.sshWorkspace.listCredentialHostIds(),
    ])
    const list = parseSshWorkspaceHosts(rawHosts)
    const credentialHosts = new Set(credentialHostIds)
    if (list.length === 0) {
      hostList.append(el('p', { class: 'field-hint' }, 'No SSH hosts configured yet.'))
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
        fillDraft(host)
      })
      row.querySelector('.ssh-host-delete')?.addEventListener('click', () => {
        void api.sshWorkspace
          .forgetCredentials(host.id)
          .then(() => persistHosts(removeHost(list, host.id)))
      })
      hostList.append(row)
    }
  }

  idInput.addEventListener('input', () => {
    idTouched = true
    draft.id = idInput.value
  })
  labelInput.addEventListener('input', () => {
    draft.label = labelInput.value
    if (!idTouched && !idInput.disabled) idInput.value = slugifyHostId(draft.label)
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
      const existing = parseSshWorkspaceHosts(raw)
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
    void api.settings.set('sshWorkspaceEnabled', enabledInput.checked).then(() => {
      opts.onChanged?.()
    })
  })
  strictSelect.addEventListener('change', () => {
    void api.settings.set('sshStrictHostKeys', strictSelect.value).then(() => {
      opts.onChanged?.()
    })
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
      const existing = parseSshWorkspaceHosts(raw)
      let next = existing
      let imported = 0
      for (const alias of aliases) {
        if (next.some((h) => h.id === alias.id)) continue
        next = upsertHost(next, alias)
        imported += 1
      }
      await persistHosts(next)
      if (imported === 0) {
        setInlineStatus(status, 'ok', 'All SSH config aliases are already imported.')
        return
      }
      setInlineStatus(status, 'ok', `Imported ${String(imported)} alias(es) from SSH config.`)
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
    hostList,
    importBtn,
    form,
    status,
  )

  return { root, refresh }
}
