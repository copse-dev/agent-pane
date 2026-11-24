import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { parseSshWorkspaceHosts } from './setup/ssh-host-helpers.ts'
import { createVncSshHostForm } from './vnc-ssh-host-form.ts'

const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/** A fake API whose saved hosts and `~/.ssh/config` hosts the test chooses. */
function apiWithConfigHosts(aliases: SshWorkspaceHost[]): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    sshWorkspace: {
      ...base.sshWorkspace,
      listConfigAliases: async (): Promise<SshWorkspaceHost[]> => Promise.resolve(aliases),
      listHosts: async (): Promise<SshWorkspaceHost[]> =>
        parseSshWorkspaceHosts(await base.settings.get('sshWorkspaceHosts')),
    },
  } satisfies ApiClient
}

it('blocks save while SSH workspaces are disabled, without changing settings', async () => {
  const api = createFakeApi()
  await api.settings.set('sshWorkspaceEnabled', false)
  const saved: string[] = []
  const form = createVncSshHostForm(
    api,
    async (id) => {
      saved.push(id)
    },
    () => {},
  )
  form.open()
  const fill = (label: string, value: string): void => {
    const input = form.root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
    assert.ok(input)
    input.value = value
  }
  assert.equal(form.root.querySelector('[aria-label="SSH host id"]'), null, 'no id to invent')
  fill('SSH host label', 'Build Mac')
  fill('SSH hostname', 'build.local')
  form.root.dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
  assert.match(
    form.root.querySelector('[role="status"]')?.textContent ?? '',
    /Enable SSH workspaces/,
  )
  assert.equal(form.root.hidden, false)
  assert.deepEqual(saved, [])
  assert.equal(await api.settings.get('sshWorkspaceHosts'), undefined)
  assert.equal(await api.settings.get('sshWorkspaceEnabled'), false)
  await api.settings.set('sshWorkspaceEnabled', true)
  form.root.dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
  assert.deepEqual(saved, ['build-mac'], 'the id comes from the label')
  assert.equal(form.root.hidden, true)
})

it('offers ~/.ssh/config hosts that are not saved yet, and saves the chosen one alone', async () => {
  const api = apiWithConfigHosts([
    { id: 'studio', label: 'studio', host: 'studio' },
    { id: 'build-box', label: 'build-box', host: 'build-box' },
  ])
  await api.settings.set('sshWorkspaceEnabled', true)
  await api.settings.set('sshWorkspaceHosts', [{ id: 'studio', label: 'Studio', host: 'studio' }])
  const saved: string[] = []
  const form = createVncSshHostForm(
    api,
    async (id) => {
      saved.push(id)
    },
    () => {},
  )
  form.open()
  await settle()

  const field = form.root.querySelector<HTMLElement>('.vnc-ssh-config-field')
  const select = form.root.querySelector<HTMLSelectElement>('.vnc-ssh-config-host')
  assert.ok(field && select)
  assert.equal(field.hidden, false)
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ['', 'build-box'],
    'a config host already saved is not offered again',
  )

  select.value = 'build-box'
  select.dispatchEvent(new Event('change'))
  await settle()
  assert.deepEqual(saved, ['build-box'])
  assert.deepEqual(await api.settings.get('sshWorkspaceHosts'), [
    { id: 'studio', label: 'Studio', host: 'studio' },
    { id: 'build-box', label: 'build-box', host: 'build-box' },
  ])
})

it('reads ~/.ssh/config only once SSH workspaces are on', async () => {
  const base = apiWithConfigHosts([{ id: 'studio', label: 'studio', host: 'studio' }])
  let reads = 0
  const api = {
    ...base,
    sshWorkspace: {
      ...base.sshWorkspace,
      listConfigAliases: async (): Promise<SshWorkspaceHost[]> => {
        reads += 1
        return base.sshWorkspace.listConfigAliases()
      },
    },
  } satisfies ApiClient
  await api.settings.set('sshWorkspaceEnabled', false)
  const form = createVncSshHostForm(
    api,
    async () => {},
    () => {},
  )
  const field = (): HTMLElement | null =>
    form.root.querySelector<HTMLElement>('.vnc-ssh-config-field')

  form.open()
  await settle()
  assert.equal(reads, 0, 'nothing reads ~/.ssh/config while SSH workspaces are off')
  assert.equal(field()?.hidden, true)

  await api.settings.set('sshWorkspaceEnabled', true)
  form.close()
  form.open()
  await settle()
  assert.equal(reads, 1)
  assert.equal(field()?.hidden, false, 'once they are on, the form offers config hosts')
})

it('hides the config picker when every config host is already saved', async () => {
  const api = apiWithConfigHosts([{ id: 'studio', label: 'studio', host: 'studio' }])
  await api.settings.set('sshWorkspaceEnabled', true)
  await api.settings.set('sshWorkspaceHosts', [{ id: 'studio', label: 'Studio', host: 'studio' }])
  const form = createVncSshHostForm(
    api,
    async () => {},
    () => {},
  )
  form.open()
  await settle()
  assert.equal(form.root.querySelector<HTMLElement>('.vnc-ssh-config-field')?.hidden, true)
})
