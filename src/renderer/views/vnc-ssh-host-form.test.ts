import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createVncSshHostForm } from './vnc-ssh-host-form.ts'

it('blocks save and import while SSH workspaces are disabled, without changing settings', async () => {
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
  fill('SSH host id', 'build-mac')
  fill('SSH host label', 'Build Mac')
  fill('SSH hostname', 'build.local')
  form.root.dispatchEvent(new Event('submit', { cancelable: true }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(
    form.root.querySelector('[role="status"]')?.textContent ?? '',
    /Enable SSH workspaces/,
  )
  assert.equal(form.root.hidden, false)
  assert.deepEqual(saved, [])
  assert.equal(await api.settings.get('sshWorkspaceHosts'), undefined)
  assert.equal(await api.settings.get('sshWorkspaceEnabled'), false)
  form.root.querySelector<HTMLButtonElement>('.ui-btn-ghost')?.click()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(
    form.root.querySelector('[role="status"]')?.textContent ?? '',
    /Enable SSH workspaces/,
  )
  assert.equal(await api.settings.get('sshWorkspaceHosts'), undefined)
  await api.settings.set('sshWorkspaceEnabled', true)
  form.root.dispatchEvent(new Event('submit', { cancelable: true }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(saved, ['build-mac'])
  assert.equal(form.root.hidden, true)
})
