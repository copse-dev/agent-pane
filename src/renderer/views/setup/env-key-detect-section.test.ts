import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, DetectedEnvKey } from '../../../preload/api.d.ts'
import { createEnvKeyDetectSection } from './env-key-detect-section.ts'

interface StubState {
  settings: Record<string, unknown>
  scanResult: DetectedEnvKey[]
  importCalls: number
  imported: { provider: string; source: string }[]
}

function stubApi(state: StubState): ApiClient {
  const api = {
    settings: {
      get: async (key: string) => state.settings[key] ?? null,
      set: async (key: string, value: unknown) => {
        state.settings[key] = value
      },
      scanEnvKeys: async () => state.scanResult,
      importEnvKeys: async () => {
        state.importCalls += 1
        return { imported: state.imported, skipped: [] }
      },
    },
  }
  return api as unknown as ApiClient
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('env-key-detect-section', () => {
  let state: StubState

  beforeEach(() => {
    document.body.innerHTML = ''
    state = { settings: {}, scanResult: [], importCalls: 0, imported: [] }
  })

  it('keeps scan disabled until the consent box is ticked', async () => {
    const section = createEnvKeyDetectSection(stubApi(state))
    document.body.append(section.root)
    await section.refresh()

    const consent = section.root.querySelector(
      'input[name="envKeyAutoDetectEnabled"]',
    ) as HTMLInputElement
    const scanBtn = section.root.querySelector('button') as HTMLButtonElement
    assert.equal(consent.checked, false)
    assert.equal(scanBtn.disabled, true)

    consent.checked = true
    consent.dispatchEvent(new Event('change'))
    await flush()

    assert.equal(state.settings['envKeyAutoDetectEnabled'], true)
    assert.equal(scanBtn.disabled, false)
  })

  it('renders masked detections and an import button for new keys', async () => {
    state.scanResult = [
      {
        provider: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        source: 'environment',
        masked: 'sk-…ab',
        alreadyConfigured: false,
      },
      {
        provider: 'openai',
        envVar: 'OPENAI_API_KEY',
        source: '~/.zshrc',
        masked: 'sk-…cd',
        alreadyConfigured: true,
      },
    ]
    const section = createEnvKeyDetectSection(stubApi(state))
    document.body.append(section.root)
    await section.refresh()

    const consent = section.root.querySelector(
      'input[name="envKeyAutoDetectEnabled"]',
    ) as HTMLInputElement
    consent.checked = true
    consent.dispatchEvent(new Event('change'))

    const [scanBtn, importBtn] = section.root.querySelectorAll('button')
    scanBtn!.dispatchEvent(new Event('click'))
    await flush()

    const rows = section.root.querySelectorAll('.env-key-row')
    assert.equal(rows.length, 2)
    assert.match(section.root.textContent ?? '', /sk-…ab/)
    // One new key → import button visible and labelled for a single key.
    assert.equal((importBtn as HTMLButtonElement).hidden, false)
    assert.equal((importBtn as HTMLButtonElement).textContent, 'Import 1 key')
  })

  it('imports keys and notifies the host', async () => {
    state.scanResult = [
      {
        provider: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        source: 'environment',
        masked: 'sk-…ab',
        alreadyConfigured: false,
      },
    ]
    state.imported = [{ provider: 'anthropic', source: 'environment' }]
    let importedCallbacks = 0
    const section = createEnvKeyDetectSection(stubApi(state), {
      onImported: () => {
        importedCallbacks += 1
      },
    })
    document.body.append(section.root)
    await section.refresh()

    const consent = section.root.querySelector(
      'input[name="envKeyAutoDetectEnabled"]',
    ) as HTMLInputElement
    consent.checked = true
    consent.dispatchEvent(new Event('change'))

    const [scanBtn, importBtn] = section.root.querySelectorAll('button')
    scanBtn!.dispatchEvent(new Event('click'))
    await flush()
    importBtn!.dispatchEvent(new Event('click'))
    await flush()

    assert.equal(state.importCalls, 1)
    assert.equal(importedCallbacks, 1)
  })

  it('hides results and disables scan when consent is withdrawn', async () => {
    state.settings['envKeyAutoDetectEnabled'] = true
    state.scanResult = [
      {
        provider: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        source: 'environment',
        masked: 'sk-…ab',
        alreadyConfigured: false,
      },
    ]
    const section = createEnvKeyDetectSection(stubApi(state))
    document.body.append(section.root)
    await section.refresh()

    const consent = section.root.querySelector(
      'input[name="envKeyAutoDetectEnabled"]',
    ) as HTMLInputElement
    const scanBtn = section.root.querySelector('button') as HTMLButtonElement
    assert.equal(consent.checked, true)
    assert.equal(scanBtn.disabled, false)

    scanBtn.dispatchEvent(new Event('click'))
    await flush()
    assert.equal(section.root.querySelectorAll('.env-key-row').length, 1)

    consent.checked = false
    consent.dispatchEvent(new Event('change'))
    await flush()

    assert.equal(state.settings['envKeyAutoDetectEnabled'], false)
    assert.equal(scanBtn.disabled, true)
    assert.equal(section.root.querySelectorAll('.env-key-row').length, 0)
  })
})
