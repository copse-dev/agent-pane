import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
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
} {
  const store = new Map<string, unknown>([
    ['sshWorkspaceEnabled', initial.enabled === true],
    ['sshWorkspaceHosts', initial.hosts ?? []],
    ['sshStrictHostKeys', initial.strict ?? 'accept-new'],
  ])
  const sets: Array<{ key: string; value: unknown }> = []
  const credentialHostIds = new Set(initial.credentialHostIds ?? [])
  const forgotten: string[] = []
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
      },
    } satisfies ApiClient
  })()
  return { api, sets, forgotten }
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
