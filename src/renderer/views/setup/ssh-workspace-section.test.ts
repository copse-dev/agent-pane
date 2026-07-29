import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import { createSshWorkspaceSection } from './ssh-workspace-section.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'

function mockApi(initial: { enabled?: boolean; hosts?: unknown[]; strict?: string }): {
  api: ApiClient
  sets: Array<{ key: string; value: unknown }>
} {
  const store = new Map<string, unknown>([
    ['sshWorkspaceEnabled', initial.enabled === true],
    ['sshWorkspaceHosts', initial.hosts ?? []],
    ['sshStrictHostKeys', initial.strict ?? 'accept-new'],
  ])
  const sets: Array<{ key: string; value: unknown }> = []
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
        listConfigAliases: async () => [],
      },
    } satisfies ApiClient
  })()
  return { api, sets }
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
})
