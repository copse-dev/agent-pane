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

it('asks to turn SSH workspaces on before saving, and saves once they are on', async () => {
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
  // Nothing is saved or turned on yet: the form asks, in place.
  const turnOn = form.root.querySelector<HTMLButtonElement>('.ssh-consent-turn-on')
  assert.ok(turnOn, 'the form asks to turn SSH workspaces on')
  assert.equal(form.root.hidden, false)
  assert.deepEqual(saved, [])
  assert.equal(await api.settings.get('sshWorkspaceHosts'), undefined)
  assert.equal(await api.settings.get('sshWorkspaceEnabled'), false)
  // A second submit does not stack a second question.
  form.root.dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
  assert.equal(form.root.querySelectorAll('.ssh-consent').length, 1)

  turnOn.click()
  await settle()
  await settle()
  assert.equal(await api.settings.get('sshWorkspaceEnabled'), true)
  assert.deepEqual(saved, ['build-mac'], 'the save carries on; the id comes from the label')
  assert.equal(form.root.hidden, true)
  assert.equal(form.root.querySelector('.ssh-consent'), null)
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

it('hides the config picker when every config host is already saved', async () => {
  const api = apiWithConfigHosts([{ id: 'studio', label: 'studio', host: 'studio' }])
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
