import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient, DetectedEnvKey, DetectedAcpAgent } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import {
  mountOnboardingDialog,
  openOnboardingDialog,
  isOnboardingDialogOpen,
  shouldShowOnboarding,
} from './onboarding-dialog.ts'

interface StubState {
  ops: string[]
  settings: Record<string, unknown>
  envKeys: DetectedEnvKey[]
  agents: DetectedAcpAgent[]
  lmRunning: boolean
  scanCalls: number
  importedProviders: string[][]
  envScanFails: boolean
}

function makeState(): StubState {
  return {
    ops: [],
    settings: {},
    envKeys: [],
    agents: [],
    lmRunning: false,
    scanCalls: 0,
    importedProviders: [],
    envScanFails: false,
  }
}

function envKey(provider: string, alreadyConfigured = false): DetectedEnvKey {
  return {
    provider,
    envVar: `${provider.toUpperCase()}_API_KEY`,
    source: '~/.zshrc',
    masked: 'sk-…abcd',
    alreadyConfigured,
  }
}

function stubApi(state: StubState): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base.settings,
      get: async (key: string): Promise<unknown> => state.settings[key] ?? null,
      set: async (key: string, value: unknown): Promise<void> => {
        state.ops.push(`set:${key}`)
        state.settings[key] = value
      },
      scanEnvKeys: async (): Promise<DetectedEnvKey[]> => {
        state.scanCalls += 1
        if (state.envScanFails) throw new Error('scan failed')
        return state.envKeys
      },
      importEnvKeys: async (
        providers?: string[],
      ): Promise<{
        imported: { provider: string; source: string }[]
        skipped: { provider: string; reason: string }[]
      }> => {
        state.ops.push('importEnvKeys')
        state.importedProviders.push(providers ?? [])
        return { imported: [], skipped: [] }
      },
    },
    lmStudio: {
      ...base.lmStudio,
      // All preset probes unreachable; LM Studio state comes from detect().
      test: async (): Promise<{ ok: boolean; error?: string }> => ({
        ok: false,
        error: 'unreachable',
      }),
      detect: async (): Promise<Awaited<ReturnType<ApiClient['lmStudio']['detect']>>> => ({
        serverRunning: state.lmRunning,
        serverUrl: 'http://127.0.0.1:1234/v1',
        installDetected: state.lmRunning,
        models: state.lmRunning ? ['local-model'] : [],
        modelContexts: {},
        preferredPresent: [],
        preferredMissing: [],
      }),
    },
    acp: {
      ...base.acp,
      detectAgents: async (): Promise<DetectedAcpAgent[]> => state.agents,
    },
  } satisfies ApiClient
}

/** Let the scan's promise chains settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('onboarding dialog', () => {
  let state: StubState
  let store: ReturnType<typeof createStore>
  let dialog: HTMLDialogElement

  function mount(api?: ApiClient): void {
    document.body.innerHTML = ''
    state = makeState()
    store = createStore()
    mountOnboardingDialog(store, api ?? stubApi(state))
    dialog = qsRequired<HTMLDialogElement>(document, '#onboarding-dialog')
  }

  async function open(): Promise<void> {
    openOnboardingDialog()
    await flush()
  }

  function rows(kind?: string): HTMLElement[] {
    const selector = kind ? `.detected-item-row[data-kind="${kind}"]` : '.detected-item-row'
    return [...dialog.querySelectorAll<HTMLElement>(selector)]
  }

  beforeEach(() => {
    mount()
  })

  it('opens modally and auto-scans without reading shell files', async () => {
    assert.equal(dialog.tagName, 'DIALOG')
    assert.equal(isOnboardingDialogOpen(), false)
    assert.equal(state.scanCalls, 0)
    await open()
    assert.equal(isOnboardingDialogOpen(), true)
    assert.equal(dialog.open, true)
    assert.equal(state.scanCalls, 0)
    assert.equal(state.settings['envKeyAutoDetectEnabled'], undefined)
  })

  it('records consent before an explicitly requested environment scan', async () => {
    state.envKeys = [envKey('anthropic')]
    state.lmRunning = true
    await open()

    qsRequired<HTMLButtonElement>(dialog, '#onboarding-scan-env').click()
    await flush()

    assert.equal(state.scanCalls, 1)
    assert.equal(state.settings['envKeyAutoDetectEnabled'], true)
    assert.ok(state.ops.includes('set:envKeyAutoDetectEnabled'))
    assert.equal(rows('env-key').length, 1)
  })

  it('renders findings as grouped rows, pre-checked unless already configured', async () => {
    state.envKeys = [envKey('anthropic'), envKey('openai', true)]
    state.lmRunning = true
    await open()
    qsRequired<HTMLButtonElement>(dialog, '#onboarding-scan-env').click()
    await flush()

    const anthropic = rows('env-key').find((row) => row.dataset['id'] === 'anthropic')
    const openai = rows('env-key').find((row) => row.dataset['id'] === 'openai')
    const anthropicBox = anthropic?.querySelector<HTMLInputElement>('input')
    const openaiBox = openai?.querySelector<HTMLInputElement>('input')
    assert.ok(anthropicBox && openaiBox)
    assert.equal(anthropicBox.checked, true)
    assert.equal(anthropicBox.disabled, false)
    // Already-configured keys can't be re-imported: unchecked and disabled.
    assert.equal(openaiBox.checked, false)
    assert.equal(openaiBox.disabled, true)

    // A running LM Studio shows as an informational row — nothing to import.
    const lmRow = rows('local-server').find((row) => row.dataset['id'] === 'lmstudio')
    assert.ok(lmRow)
    assert.equal(lmRow.querySelector('input'), null)
    assert.match(lmRow.textContent, /used automatically/)
  })

  it('finish imports only what stayed ticked', async () => {
    state.envKeys = [envKey('anthropic'), envKey('mistral')]
    await open()
    qsRequired<HTMLButtonElement>(dialog, '#onboarding-scan-env').click()
    await flush()

    const mistralBox = rows('env-key')
      .find((row) => row.dataset['id'] === 'mistral')
      ?.querySelector<HTMLInputElement>('input')
    assert.ok(mistralBox)
    mistralBox.checked = false

    qsRequired<HTMLButtonElement>(dialog, '#onboarding-finish').click()
    await flush()
    assert.deepEqual(state.importedProviders, [['anthropic']])
    // Consent was recorded before the import ran.
    assert.ok(state.ops.indexOf('set:envKeyAutoDetectEnabled') < state.ops.indexOf('importEnvKeys'))
  })

  it('finish writes relative-selector defaults, completes, and closes', async () => {
    let settingsChanged = 0
    store.on('settings_changed', () => {
      settingsChanged += 1
    })
    await open()
    qsRequired<HTMLButtonElement>(dialog, '#onboarding-finish').click()
    await flush()

    assert.equal(state.settings['onboardingCompleted'], true)
    assert.equal(state.settings['model'], 'auto:balanced')
    assert.equal(state.settings['localDefaultModel'], 'auto:best-local')
    assert.equal(store.getState().settings?.model, 'auto:balanced')
    assert.equal(settingsChanged, 1)
    assert.equal(dialog.open, false)
  })

  it('a failed explicit environment scan leaves automatic findings usable', async () => {
    state.envScanFails = true
    state.lmRunning = true
    await open()
    qsRequired<HTMLButtonElement>(dialog, '#onboarding-scan-env').click()
    await flush()

    assert.ok(rows('local-server').length > 0)
    assert.match(qsRequired(dialog, '#onboarding-env-status').textContent, /scan failed/)
    assert.equal(state.settings['envKeyAutoDetectEnabled'], true)
    assert.equal(qsRequired<HTMLButtonElement>(dialog, '#onboarding-finish').disabled, false)
  })

  it('an empty scan swaps in the providers fallback panel', async () => {
    await open()

    assert.equal(qsRequired(dialog, '#onboarding-scan-panel').hidden, true)
    const fallbackPanel = qsRequired(dialog, '#onboarding-fallback-panel')
    assert.equal(fallbackPanel.hidden, false)
    assert.ok(fallbackPanel.querySelector('.provider-chips'), 'providers panel should mount')
    assert.equal(
      qsRequired<HTMLButtonElement>(dialog, '#onboarding-finish').textContent.trim(),
      'Finish',
    )

    qsRequired<HTMLButtonElement>(dialog, '#onboarding-finish').click()
    await flush()
    assert.equal(state.settings['onboardingCompleted'], true)
    assert.equal(state.settings['localSubagentsEnabled'], false)
    assert.equal(dialog.open, false)
  })

  for (const dismiss of [
    {
      name: 'Skip',
      act: (): void => {
        qsRequired<HTMLButtonElement>(dialog, '#onboarding-skip').click()
      },
    },
    {
      name: 'the close button',
      act: (): void => {
        qsRequired<HTMLButtonElement>(dialog, '#onboarding-close').click()
      },
    },
    // Esc funnels through the same native close event.
    {
      name: 'Esc',
      act: (): void => {
        dialog.close()
      },
    },
  ]) {
    it(`${dismiss.name} completes onboarding without importing anything`, async () => {
      state.envKeys = [envKey('anthropic')]
      await open()
      dismiss.act()
      await flush()

      assert.equal(dialog.open, false)
      assert.equal(state.settings['onboardingCompleted'], true)
      assert.ok(!state.ops.includes('importEnvKeys'))
      assert.equal(state.settings['envKeyAutoDetectEnabled'], undefined)
      // Dismissal writes nothing but the flag — no model defaults.
      assert.equal(state.settings['model'], undefined)
    })
  }

  it('re-dispatching open while visible does not duplicate automatic rows or scan shell files', async () => {
    state.lmRunning = true
    await open()
    dialog.dispatchEvent(new Event('onboarding-open'))
    await flush()
    assert.equal(rows('local-server').filter((row) => row.dataset['id'] === 'lmstudio').length, 1)
    assert.equal(state.scanCalls, 0)
  })
})

describe('shouldShowOnboarding', () => {
  function apiWithCompleted(value: unknown): ApiClient {
    const base = createFakeApi()
    return {
      ...base,
      settings: { ...base.settings, get: async (): Promise<unknown> => value },
    } satisfies ApiClient
  }

  it('shows only until the completed flag is true', async () => {
    assert.equal(await shouldShowOnboarding(apiWithCompleted(true)), false)
    assert.equal(await shouldShowOnboarding(apiWithCompleted(false)), true)
    assert.equal(await shouldShowOnboarding(apiWithCompleted(undefined)), true)
    assert.equal(await shouldShowOnboarding(apiWithCompleted(null)), true)
  })
})
