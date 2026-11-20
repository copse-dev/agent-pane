import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import type { SshConnectionState, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { createSshWorkspaceSection } from './ssh-workspace-section.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'

function mockApi(initial: {
  enabled?: boolean
  hosts?: unknown[]
  strict?: string
  credentialHostIds?: string[]
  configAliases?: SshWorkspaceHost[]
}): {
  api: ApiClient
  sets: Array<{ key: string; value: unknown }>
  forgotten: string[]
  /** Change the live SSH states, as the main process announces them. */
  setStates: (next: SshConnectionState[]) => void
} {
  const store = new Map<string, unknown>([
    ['sshWorkspaceEnabled', initial.enabled === true],
    ['sshWorkspaceHosts', initial.hosts ?? []],
    ['sshStrictHostKeys', initial.strict ?? 'accept-new'],
  ])
  const sets: Array<{ key: string; value: unknown }> = []
  const credentialHostIds = new Set(initial.credentialHostIds ?? [])
  const forgotten: string[] = []
  let states: SshConnectionState[] = []
  let onChanged: ((next: SshConnectionState[]) => void) | undefined
  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      settings: {
        ...base['settings'],
        get: async (key: string): Promise<unknown> => store.get(key) ?? null,
        set: async (key: string, value: unknown): Promise<void> => {
          sets.push({ key, value })
          store.set(key, value)
        },
      },
      sshWorkspace: {
        ...base['sshWorkspace'],
        listConfigAliases: async () => initial.configAliases ?? [],
        listCredentialHostIds: async () => [...credentialHostIds],
        forgetCredentials: async (hostId: string): Promise<void> => {
          forgotten.push(hostId)
          credentialHostIds.delete(hostId)
        },
        getStates: async (): Promise<SshConnectionState[]> => states,
        onConnectionChanged: (handler: (next: SshConnectionState[]) => void): (() => void) => {
          onChanged = handler
          return (): void => {
            onChanged = undefined
          }
        },
      },
    } satisfies ApiClient
  })()
  return {
    api,
    sets,
    forgotten,
    setStates: (next): void => {
      states = next
      onChanged?.(next)
    },
  }
}

describe('createSshWorkspaceSection', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('loads the enable toggle from settings on refresh', async () => {
    const { api } = mockApi({ enabled: true })
    const section = createSshWorkspaceSection(api)
    document.body.append(section.root)
    await section.refresh()
    const toggle = section.root.querySelector<HTMLInputElement>('input[name="sshWorkspaceEnabled"]')
    assert.ok(toggle)
    assert.equal(toggle.checked, true)
  })

  it('persists the enable toggle and notifies onChanged without Save', async () => {
    const { api, sets } = mockApi({ enabled: false })
    let changed = 0
    const section = createSshWorkspaceSection(api, {
      onChanged: () => {
        changed += 1
      },
    })
    document.body.append(section.root)
    await section.refresh()

    const toggle = section.root.querySelector<HTMLInputElement>('input[name="sshWorkspaceEnabled"]')
    assert.ok(toggle)
    assert.equal(toggle.checked, false)

    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(sets.at(-1), { key: 'sshWorkspaceEnabled', value: true })
    assert.equal(changed, 1)
  })

  it('notifies live consumers when a saved host changes', async () => {
    const { api, sets } = mockApi({ hosts: [] })
    let changed = 0
    const section = createSshWorkspaceSection(api, {
      onChanged: () => {
        changed += 1
      },
    })
    document.body.append(section.root)
    await section.refresh()

    const label = section.root.querySelector<HTMLInputElement>('input[name="sshHostLabel"]')
    const host = section.root.querySelector<HTMLInputElement>('input[name="sshHostHost"]')
    const save = section.root.querySelector<HTMLButtonElement>('.ssh-host-save')
    assert.ok(label)
    assert.ok(host)
    assert.ok(save)
    label.value = 'Studio Mac'
    label.dispatchEvent(new Event('input'))
    host.value = 'studio.local'
    host.dispatchEvent(new Event('input'))
    save.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(changed, 1)
    assert.deepEqual(sets.at(-1), {
      key: 'sshWorkspaceHosts',
      value: [{ id: 'studio-mac', label: 'Studio Mac', host: 'studio.local' }],
    })
  })

  it('marks only the rejected field invalid and clears the mark once it is edited', async () => {
    const { api, sets } = mockApi({ hosts: [] })
    const section = createSshWorkspaceSection(api)
    document.body.append(section.root)
    await section.refresh()

    const input = (name: string): HTMLInputElement => {
      const node = section.root.querySelector<HTMLInputElement>(`input[name="${name}"]`)
      assert.ok(node, name)
      return node
    }
    // Nobody types a host id any more: it comes from the label.
    assert.equal(section.root.querySelector('input[name="sshHostId"]'), null)
    for (const name of ['sshHostLabel', 'sshHostHost', 'sshHostUser', 'sshHostPort']) {
      assert.equal(input(name).getAttribute('type'), 'text', `${name} names its type`)
    }
    const type = (name: string, value: string): void => {
      input(name).value = value
      input(name).dispatchEvent(new Event('input'))
    }
    type('sshHostLabel', 'Studio Mac')
    type('sshHostHost', 'studio.local')
    type('sshHostPort', '22garbage')
    section.root.querySelector<HTMLButtonElement>('.ssh-host-save')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(sets.length, 0)
    assert.equal(input('sshHostPort').getAttribute('aria-invalid'), 'true')
    assert.equal(input('sshHostHost').hasAttribute('aria-invalid'), false)
    type('sshHostPort', '2222')
    assert.equal(input('sshHostPort').hasAttribute('aria-invalid'), false)
  })

  it('gives a new host a unique id from its label, and keeps an edited host its own', async () => {
    const existing = { id: 'studio-mac', label: 'Studio Mac', host: 'old.local' }
    const { api, sets } = mockApi({ hosts: [existing] })
    const section = createSshWorkspaceSection(api)
    document.body.append(section.root)
    await section.refresh()
    const input = (name: string): HTMLInputElement => {
      const node = section.root.querySelector<HTMLInputElement>(`input[name="${name}"]`)
      assert.ok(node, name)
      return node
    }
    const save = async (): Promise<void> => {
      section.root.querySelector<HTMLButtonElement>('.ssh-host-save')?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    input('sshHostLabel').value = 'Studio Mac'
    input('sshHostHost').value = 'studio.local'
    input('sshHostForwardAgent').checked = true
    await save()
    assert.deepEqual(sets.at(-1)?.value, [
      existing,
      { id: 'studio-mac-2', label: 'Studio Mac', host: 'studio.local', forwardAgent: true },
    ])

    section.root.querySelector<HTMLButtonElement>('.ssh-host-edit')?.click()
    assert.equal(input('sshHostHost').value, 'old.local')
    input('sshHostLabel').value = 'Renamed'
    await save()
    const hosts = sets.at(-1)?.value
    assert.ok(Array.isArray(hosts))
    assert.deepEqual(hosts[0], { id: 'studio-mac', label: 'Renamed', host: 'old.local' })
  })

  it('shows and deletes OS-keychain authentication without removing the host', async () => {
    const host = { id: 'dev', label: 'Dev Server', host: 'dev.example' }
    const { api, forgotten, sets } = mockApi({ hosts: [host], credentialHostIds: ['dev'] })
    const section = createSshWorkspaceSection(api)
    document.body.append(section.root)
    await section.refresh()

    const auth = section.root.querySelector<HTMLElement>('.ssh-host-auth')
    const forget = section.root.querySelector<HTMLButtonElement>('.ssh-host-forget-auth')
    assert.equal(auth?.textContent, 'Authentication encrypted by OS keychain')
    assert.ok(forget)

    forget.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(forgotten, ['dev'])
    assert.equal(sets.length, 0)
    assert.equal(section.root.querySelector('.ssh-host-forget-auth'), null)
    assert.match(section.root.querySelector('.ssh-host-auth')?.textContent ?? '', /requested/)
  })

  it('forgets authentication before removing a configured host', async () => {
    const host = { id: 'dev', label: 'Dev Server', host: 'dev.example' }
    const { api, forgotten, sets } = mockApi({ hosts: [host], credentialHostIds: ['dev'] })
    const section = createSshWorkspaceSection(api)
    document.body.append(section.root)
    await section.refresh()

    section.root.querySelector<HTMLButtonElement>('.ssh-host-delete')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(forgotten, ['dev'])
    assert.deepEqual(sets.at(-1), { key: 'sshWorkspaceHosts', value: [] })
  })

  it('imports colliding SSH aliases as separate hosts', async () => {
    const configAliases = [
      { id: 'build-prod-a1b2c3d4', label: 'build.prod', host: 'build.prod' },
      { id: 'build-prod', label: 'build-prod', host: 'build-prod' },
    ]
    const { api, sets } = mockApi({ hosts: [], configAliases })
    const section = createSshWorkspaceSection(api)
    document.body.append(section.root)
    await section.refresh()

    section.root.querySelector<HTMLButtonElement>('.ssh-import-config')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(sets.at(-1), { key: 'sshWorkspaceHosts', value: configAliases })
    assert.equal(section.root.querySelectorAll('.ssh-host-row').length, 2)
    assert.equal(
      section.root.querySelector('.ssh-host-status')?.textContent,
      'Imported 2 alias(es) from SSH config.',
    )
  })
})

describe('createSshWorkspaceSection in the shared Machines list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders its rows, with status and capabilities, into the list it is given', async () => {
    const { api } = mockApi({ hosts: [{ id: 'dev', label: 'Dev Server', host: 'dev.example' }] })
    const overview = document.createElement('div')
    const shared = document.createElement('div')
    overview.append(shared)
    const section = createSshWorkspaceSection(api, { hostList: shared })
    document.body.append(overview, section.root)
    await section.refresh()

    assert.equal(shared.parentElement, overview, 'the shared list stays where it was put')
    assert.equal(section.root.querySelector('.ssh-host-row'), null, 'no second list of its own')
    const row = shared.querySelector('.ssh-host-row')
    assert.ok(row)
    assert.equal(row.querySelector('.machine-summary-status')?.textContent, 'Not connected')
    assert.deepEqual(
      [...row.querySelectorAll('.machine-use')].map((item) => item.textContent),
      ['Files and shell'],
    )
    // Every action the row had before is still on it.
    for (const action of ['.ssh-host-edit', '.ssh-host-delete']) {
      assert.ok(row.querySelector(action), action)
    }
  })

  it('follows the live connection without a refresh', async () => {
    const { api, setStates } = mockApi({
      hosts: [{ id: 'dev', label: 'Dev Server', host: 'dev.example' }],
    })
    const shared = document.createElement('div')
    const section = createSshWorkspaceSection(api, { hostList: shared })
    document.body.append(shared, section.root)
    await section.refresh()
    const status = (): string | null | undefined =>
      shared.querySelector('.machine-summary-status')?.textContent
    assert.equal(status(), 'Not connected')

    // Pairing a machine over SSH, for one, connects the host while Settings is open.
    setStates([{ hostId: 'dev', status: 'connected', label: 'Dev Server', target: 'dev.example' }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(status(), 'Connected')
  })

  it('draws each row once when renders overlap', async () => {
    const { api } = mockApi({ hosts: [{ id: 'dev', label: 'Dev Server', host: 'dev.example' }] })
    const shared = document.createElement('div')
    const section = createSshWorkspaceSection(api, { hostList: shared })
    document.body.append(shared, section.root)
    await Promise.all([section.refresh(), section.refresh()])
    assert.equal(shared.querySelectorAll('.ssh-host-row').length, 1)
  })
})
