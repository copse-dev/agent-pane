import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, DetectedEnvKey } from '../../../preload/api.d.ts'
import { createEnvKeyDetectSection } from './env-key-detect-section.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'

interface StubState {
  settings: Record<string, unknown>
  scanResult: DetectedEnvKey[]
  importCalls: number
  imported: { provider: string; source: string }[]
}

function stubApi(state: StubState): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base.settings,
      get: async (key: string): Promise<unknown> => state.settings[key] ?? null,
      set: async (key: string, value: unknown): Promise<void> => {
        state.settings[key] = value
      },
      scanEnvKeys: async (): Promise<DetectedEnvKey[]> => state.scanResult,
      importEnvKeys: async (): Promise<{
        imported: { provider: string; source: string }[]
        skipped: { provider: string; reason: string }[]
      }> => {
        state.importCalls += 1
        return { imported: state.imported, skipped: [] }
      },
    },
  } satisfies ApiClient
}

const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

describe('env-key-detect-section', () => {
  let state: StubState

  beforeEach(() => {
    document.body.innerHTML = ''
    state = { settings: {}, scanResult: [], importCalls: 0, imported: [] }
  })

  it('records consent and renders masked detections on scan', async () => {
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

    const [scanBtn, importBtn] = section.root.querySelectorAll('button')
    assert.ok(scanBtn)
    assert.ok(importBtn instanceof window.HTMLButtonElement)
    scanBtn.dispatchEvent(new Event('click'))
    await flush()

    // Clicking scan is the explicit opt-in.
    assert.equal(state.settings['envKeyAutoDetectEnabled'], true)
    const rows = section.root.querySelectorAll('.env-key-row')
    assert.equal(rows.length, 2)
    assert.match(section.root.textContent, /sk-…ab/)
    // One new key → import button visible and labelled for a single key.
    assert.equal(importBtn.hidden, false)
    assert.equal(importBtn.textContent, 'Import 1 key')
  })

  it('hides the import button when every detected key is already configured', async () => {
    state.scanResult = [
      {
        provider: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        source: 'environment',
        masked: 'sk-…ab',
        alreadyConfigured: true,
      },
    ]
    const section = createEnvKeyDetectSection(stubApi(state))
    document.body.append(section.root)

    const [scanBtn, importBtn] = section.root.querySelectorAll('button')
    assert.ok(scanBtn)
    assert.ok(importBtn instanceof window.HTMLButtonElement)
    scanBtn.dispatchEvent(new Event('click'))
    await flush()

    assert.equal(section.root.querySelectorAll('.env-key-row').length, 1)
    assert.equal(importBtn.hidden, true)
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

    const [scanBtn, importBtn] = section.root.querySelectorAll('button')
    assert.ok(scanBtn)
    scanBtn.dispatchEvent(new Event('click'))
    await flush()
    assert.ok(importBtn)
    importBtn.dispatchEvent(new Event('click'))
    await flush()

    assert.equal(state.importCalls, 1)
    assert.equal(importedCallbacks, 1)
  })

  it('clears results on refresh', async () => {
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

    const scanBtn = qsRequired<HTMLButtonElement>(section.root, 'button')
    scanBtn.dispatchEvent(new Event('click'))
    await flush()
    assert.equal(section.root.querySelectorAll('.env-key-row').length, 1)

    await section.refresh()
    assert.equal(section.root.querySelectorAll('.env-key-row').length, 0)
  })
})
