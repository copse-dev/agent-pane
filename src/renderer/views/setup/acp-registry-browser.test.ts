import '../../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import type { AcpRegistryEntry } from '@shared/acp-registry.ts'
import { parseAcpAgentConfigs } from '@shared/acp.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createAcpRegistryBrowser } from './acp-registry-browser.ts'
import { createProvidersPanel } from './providers-section.ts'
import { registryToDraft } from './acp-agents-section.ts'
import { fetchModelOptions } from '../model-options.ts'

const candidate: AcpRegistryEntry = {
  id: 'new-agent',
  title: 'Community Agent',
  version: '1.2.3',
  description: 'An independently published agent.',
  packages: ['npm: community-agent@1.2.3'],
  platforms: [],
  args: ['--acp'],
  installedPath: null,
}
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === label)
  assert.ok(found, `button ${label}`)
  return found
}

describe('agent registry browser', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('loads only on request, renders metadata literally, searches and opens a draft without side effects', async () => {
    const base = createFakeApi()
    const requests: (boolean | undefined)[] = []
    const chosen: AcpRegistryEntry[] = []
    const api: ApiClient = {
      ...base,
      acp: {
        ...base.acp,
        browseRegistry: async (refresh) => {
          requests.push(refresh)
          return {
            entries: [{ ...candidate, description: '<img src=x onerror=alert(1)>' }],
            fetchedAt: 1,
            skipped: 2,
          }
        },
        probeAgent: async () => {
          throw new Error('must not probe')
        },
        autoSetup: async () => {
          throw new Error('must not install')
        },
      },
    }
    const root = createAcpRegistryBrowser(api, (entry) => chosen.push(entry))
    document.body.append(root)
    assert.deepEqual(requests, [])
    button(root, 'Browse agent registry').click()
    await flush()
    assert.deepEqual(requests, [false])
    assert.equal(root.querySelector('img'), null)
    assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/)
    assert.match(root.textContent, /Installed status unknown/)
    assert.match(root.textContent, /2 invalid or duplicate/)
    const search = root.querySelector('input')
    assert.ok(search)
    search.value = 'absent'
    search.dispatchEvent(new Event('input'))
    assert.match(root.textContent, /No agents match/)
    search.value = 'community-agent'
    search.dispatchEvent(new Event('input'))
    button(root, 'Review configuration').click()
    assert.equal(chosen.length, 1)
    assert.equal(root.querySelector('.acp-registry-toggle')?.getAttribute('aria-expanded'), 'false')
  })

  it('offers retry after failure and retains the last result when a refresh fails', async () => {
    const base = createFakeApi()
    let attempts = 0
    const api: ApiClient = {
      ...base,
      acp: {
        ...base.acp,
        browseRegistry: async () => {
          if (++attempts !== 2) throw new Error('Offline')
          return { entries: [candidate], fetchedAt: 1, skipped: 0 }
        },
      },
    }
    const root = createAcpRegistryBrowser(api, () => {})
    button(root, 'Browse agent registry').click()
    await flush()
    assert.match(root.textContent, /Could not load.*Offline/)
    assert.equal(button(root, 'Refresh registry').disabled, false)
    button(root, 'Refresh registry').click()
    await flush()
    assert.equal(root.querySelectorAll('.acp-registry-entry').length, 1)
    button(root, 'Refresh registry').click()
    await flush()
    assert.match(root.textContent, /Previously loaded entries/)
    assert.equal(root.querySelectorAll('.acp-registry-entry').length, 1)
  })

  it('bounds the rendered list and reports an empty registry', async () => {
    const base = createFakeApi()
    let entries = Array.from({ length: 25 }, (_, i) => ({ ...candidate, id: `agent-${String(i)}` }))
    const api: ApiClient = {
      ...base,
      acp: { ...base.acp, browseRegistry: async () => ({ entries, fetchedAt: 1, skipped: 0 }) },
    }
    const root = createAcpRegistryBrowser(api, () => {})
    button(root, 'Browse agent registry').click()
    await flush()
    assert.equal(root.querySelectorAll('.acp-registry-entry').length, 20)
    button(root, 'Show more').click()
    assert.equal(root.querySelectorAll('.acp-registry-entry').length, 25)
    entries = []
    button(root, 'Refresh registry').click()
    await flush()
    assert.match(root.textContent, /no usable entries/)
  })

  it('uses the real Providers add flow and requires a separate enable action before picker availability', async () => {
    const base = createFakeApi()
    let saved: unknown = []
    let requests = 0
    let probes = 0
    let setups = 0
    let completeScan = (): void => {}
    const api: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        get: async (key) => (key === 'registeredAcpAgents' ? saved : null),
        set: async (key, value) => {
          assert.equal(key, 'registeredAcpAgents')
          saved = value
        },
      },
      acp: {
        ...base.acp,
        detectAgents: () =>
          new Promise((resolve) => {
            completeScan = (): void => {
              resolve([])
            }
          }),
        browseRegistry: async () => {
          requests++
          return { entries: [candidate], fetchedAt: 1, skipped: 0 }
        },
        autoSetup: async () => {
          setups++
          return base.acp.autoSetup()
        },
        probeAgent: async () => {
          probes++
          return { models: null, modes: null }
        },
      },
    }
    const panel = createProvidersPanel(api)
    document.body.append(panel.root)
    await panel.refresh()
    assert.equal(requests, 0)
    panel.root.querySelector<HTMLButtonElement>('[data-provider="other"]')?.click()
    const kind = panel.root.querySelector('select')
    assert.ok(kind)
    kind.value = 'agent'
    kind.dispatchEvent(new Event('change'))
    await flush()
    assert.equal(requests, 0)
    button(panel.root, 'Browse agent registry').click()
    await flush()
    button(panel.root, 'Review configuration').click()
    const fields = panel.root.querySelectorAll<HTMLInputElement>('.acp-agent-fields input')
    const [id, title, command] = fields
    assert.equal(id?.value, 'registry-new-agent')
    assert.equal(title?.value, 'Community Agent')
    assert.ok(command)
    assert.equal(command.value, '')
    command.value = 'community-agent'
    completeScan()
    await flush()
    assert.equal(command.isConnected, true, 'a late PATH scan must preserve the reviewed draft')
    assert.equal(command.value, 'community-agent')
    const enabled = panel.root.querySelector<HTMLInputElement>('.checkbox-label input')
    assert.ok(enabled)
    assert.equal(enabled.checked, false)
    assert.equal(enabled.disabled, true)
    button(panel.root, 'Add agent').click()
    await flush()
    const stored = parseAcpAgentConfigs(saved)
    const agent = stored[0]
    assert.ok(agent)
    assert.equal(agent.enabled, false)
    assert.equal(agent.sandbox, undefined)
    assert.equal(agent.env, undefined)
    assert.equal(
      (await fetchModelOptions(api, '')).some((entry) => entry.value === 'acp:registry-new-agent'),
      false,
    )
    panel.root.querySelector<HTMLButtonElement>('[data-provider="registry-new-agent"]')?.click()
    const enable = panel.root.querySelector<HTMLInputElement>('.checkbox-label input')
    assert.ok(enable)
    assert.equal(enable.disabled, false)
    assert.equal(button(panel.root, 'Detect models').disabled, true)
    assert.match(panel.root.textContent, /Enable and save the agent first/)
    button(panel.root, 'Detect models').click()
    await flush()
    assert.equal(probes, 0)
    enable.checked = true
    assert.equal(button(panel.root, 'Detect models').disabled, true)
    button(panel.root, 'Save').click()
    await flush()
    assert.equal(
      (await fetchModelOptions(api, '')).some((entry) => entry.value === 'acp:registry-new-agent'),
      true,
    )
    assert.equal(probes, 0)
    assert.equal(button(panel.root, 'Detect models').disabled, false)
    button(panel.root, 'Detect models').click()
    await flush()
    assert.equal(probes, 1)
    const disable = panel.root.querySelector<HTMLInputElement>('.checkbox-label input')
    assert.ok(disable)
    disable.checked = false
    button(panel.root, 'Save').click()
    await flush()
    assert.equal(button(panel.root, 'Detect models').disabled, true)
    assert.equal(setups, 0)
  })

  it('cannot inherit catalog permissions from a colliding registry id', () => {
    assert.deepEqual(
      registryToDraft({
        ...candidate,
        id: 'claude-acp',
        command: 'evil',
        installedPath: '/bin/evil',
      }),
      {
        id: 'registry-claude-acp',
        title: candidate.title,
        command: '/bin/evil',
        args: ['--acp'],
        enabled: false,
      },
    )
  })
})
