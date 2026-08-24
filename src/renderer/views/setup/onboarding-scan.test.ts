import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ApiClient,
  DetectedEnvKey,
  DetectedAcpAgent,
  ExtraProvider,
} from '../../../preload/api.d.ts'
import { parseDynamicModel, BALANCED_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import { LM_STUDIO_MODEL_IDS } from '@shared/lm-studio-defaults.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { localServerTargets } from './local-detection.ts'
import { parseAcpAgentConfigs } from '@shared/acp.ts'
import {
  runOnboardingScan,
  hasUsableFindings,
  importScanFindings,
  deriveDefaultSettings,
  type ScanFindings,
} from './onboarding-scan.ts'

function envKey(provider: string, alreadyConfigured = false): DetectedEnvKey {
  return {
    provider,
    envVar: `${provider.toUpperCase()}_API_KEY`,
    source: '~/.zshrc',
    masked: 'sk-…abcd',
    alreadyConfigured,
  }
}

function acpAgent(id: string, installed = true): DetectedAcpAgent {
  return {
    id,
    title: id,
    command: id,
    args: ['--acp'],
    installed,
    path: installed ? `/usr/local/bin/${id}` : null,
    running: false,
  }
}

function extraProvider(id: string, models: { id: string }[]): ExtraProvider {
  return {
    id,
    label: id,
    prefix: `${id}:`,
    baseUrl: `http://127.0.0.1:0/v1`,
    builtin: true,
    local: true,
    keyLabel: 'API key',
    keyPlaceholder: 'key',
    keyHint: '',
    fallbackContextWindow: 8192,
    models,
  }
}

interface StubState {
  ops: string[]
  settings: Record<string, unknown>
  extraProviders: ExtraProvider[]
  /** Preset slug → model ids its server reports (reachable iff present). */
  servers: Record<string, string[]>
  envKeys: DetectedEnvKey[]
  agents: DetectedAcpAgent[]
  lmDetect: { serverRunning: boolean; installDetected: boolean; models: string[] }
  autoSetupCalls: number
  importedProviders: string[][]
}

function makeState(): StubState {
  return {
    ops: [],
    settings: {},
    extraProviders: [],
    servers: {},
    envKeys: [],
    agents: [],
    lmDetect: { serverRunning: false, installDetected: false, models: [] },
    autoSetupCalls: 0,
    importedProviders: [],
  }
}

function stubApi(state: StubState): ApiClient {
  const base = createFakeApi()
  const urlToId = new Map(localServerTargets().map((target) => [target.baseUrl, target.id]))
  return {
    ...base,
    settings: {
      ...base.settings,
      get: async (key: string): Promise<unknown> => state.settings[key] ?? null,
      set: async (key: string, value: unknown): Promise<void> => {
        state.ops.push(`set:${key}`)
        state.settings[key] = value
      },
      scanEnvKeys: async (): Promise<DetectedEnvKey[]> => state.envKeys,
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
      extraProviders: async (): Promise<ExtraProvider[]> => {
        state.ops.push('extraProviders')
        // A live read of current state: concurrent imports would both see the
        // same snapshot and clobber each other on save.
        return state.extraProviders
      },
      saveExtraProvider: async (record: {
        slug?: string
        models?: { id: string }[]
      }): Promise<ExtraProvider[]> => {
        state.ops.push(`saveExtraProvider:${record.slug ?? ''}`)
        state.extraProviders = [
          ...state.extraProviders.filter((provider) => provider.id !== record.slug),
          extraProvider(record.slug ?? '', record.models ?? []),
        ]
        return state.extraProviders
      },
    },
    lmStudio: {
      ...base.lmStudio,
      test: async (url: string): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
        const id = urlToId.get(url)
        const models = id ? state.servers[id] : undefined
        return models ? { ok: true, models } : { ok: false, error: 'unreachable' }
      },
      detect: async (): Promise<Awaited<ReturnType<ApiClient['lmStudio']['detect']>>> => ({
        serverRunning: state.lmDetect.serverRunning,
        serverUrl: 'http://127.0.0.1:1234/v1',
        installDetected: state.lmDetect.installDetected,
        models: state.lmDetect.models,
        modelContexts: {},
        preferredPresent: [],
        preferredMissing: [],
      }),
    },
    acp: {
      ...base.acp,
      detectAgents: async (): Promise<DetectedAcpAgent[]> => state.agents,
      autoSetup: async (): Promise<Awaited<ReturnType<ApiClient['acp']['autoSetup']>>> => {
        state.autoSetupCalls += 1
        return { installed: [], upgraded: [], registered: [], modelsDetected: [], failed: [] }
      },
    },
  } satisfies ApiClient
}

function emptyFindings(overrides: Partial<ScanFindings> = {}): ScanFindings {
  return {
    envKeys: [],
    localServers: [],
    acpAgents: [],
    lmStudio: null,
    errors: [],
    ...overrides,
  }
}

describe('runOnboardingScan', () => {
  let state: StubState

  beforeEach(() => {
    state = makeState()
  })

  it('aggregates all four probes into one findings object', async () => {
    state.envKeys = [envKey('anthropic')]
    state.servers = { jan: ['jan-model'] }
    state.agents = [acpAgent('claude-code')]
    state.lmDetect = { serverRunning: true, installDetected: true, models: ['osaurus'] }

    const findings = await runOnboardingScan(stubApi(state))
    assert.deepEqual(findings.errors, [])
    assert.deepEqual(
      findings.envKeys.map((key) => key.provider),
      ['anthropic'],
    )
    const jan = findings.localServers.find((server) => server.id === 'jan')
    assert.ok(jan?.reachable)
    assert.deepEqual(jan.models, ['jan-model'])
    assert.deepEqual(
      findings.acpAgents.map((agent) => agent.id),
      ['claude-code'],
    )
    assert.deepEqual(findings.lmStudio, {
      installed: true,
      serverUrl: 'http://127.0.0.1:1234/v1',
      running: true,
      models: ['osaurus'],
    })
  })

  it('reports LM Studio only via its dedicated probe, never as a duplicate server row', async () => {
    const findings = await runOnboardingScan(stubApi(state))
    assert.ok(!findings.localServers.some((server) => server.id === 'lmstudio'))
  })

  it('a rejected probe becomes an errors entry without sinking the others', async () => {
    state.envKeys = [envKey('anthropic')]
    const api = stubApi(state)
    api.acp.detectAgents = async (): Promise<DetectedAcpAgent[]> => {
      throw new Error('acp exploded')
    }
    const findings = await runOnboardingScan(api)
    assert.deepEqual(findings.errors, [{ probe: 'acp-agents', message: 'acp exploded' }])
    assert.equal(findings.acpAgents.length, 0)
    assert.deepEqual(
      findings.envKeys.map((key) => key.provider),
      ['anthropic'],
    )
  })

  it('a rejected env-key scan still leaves servers and agents intact', async () => {
    state.servers = { ollama: ['llama'] }
    const api = stubApi(state)
    api.settings.scanEnvKeys = async (): Promise<DetectedEnvKey[]> => {
      throw new Error('scan failed')
    }
    const findings = await runOnboardingScan(api)
    assert.deepEqual(findings.errors, [{ probe: 'env-keys', message: 'scan failed' }])
    assert.ok(findings.localServers.find((server) => server.id === 'ollama')?.reachable)
  })
})

describe('hasUsableFindings', () => {
  it('is true for an importable env key', () => {
    assert.equal(hasUsableFindings(emptyFindings({ envKeys: [envKey('anthropic')] })), true)
  })

  it('is false when every detected key is already configured', () => {
    assert.equal(hasUsableFindings(emptyFindings({ envKeys: [envKey('anthropic', true)] })), false)
  })

  it('is true for a reachable local server or a running LM Studio', () => {
    assert.equal(
      hasUsableFindings(
        emptyFindings({
          localServers: [
            { id: 'jan', label: 'Jan', baseUrl: 'http://x', reachable: true, models: [] },
          ],
        }),
      ),
      true,
    )
    assert.equal(
      hasUsableFindings(
        emptyFindings({
          lmStudio: { installed: true, serverUrl: 'http://x', running: true, models: [] },
        }),
      ),
      true,
    )
  })

  it('is false for unreachable servers, a stopped LM Studio, and agents alone', () => {
    assert.equal(
      hasUsableFindings(
        emptyFindings({
          localServers: [
            { id: 'jan', label: 'Jan', baseUrl: 'http://x', reachable: false, models: [] },
          ],
          lmStudio: { installed: true, serverUrl: 'http://x', running: false, models: [] },
          acpAgents: [acpAgent('claude-code')],
        }),
      ),
      false,
    )
  })
})

describe('importScanFindings', () => {
  let state: StubState

  beforeEach(() => {
    state = makeState()
  })

  it('imports selected reachable presets sequentially (read-modify-write survives)', async () => {
    state.servers = { ollama: ['llama'], jan: ['jan-model'] }
    const api = stubApi(state)
    const findings = await runOnboardingScan(api)
    const result = await importScanFindings(api, findings, {
      envKeyProviders: [],
      localServerIds: ['ollama', 'jan'],
      acpAgentIds: [],
    })
    assert.deepEqual(result.errors, [])
    // Both providers survive: a concurrent pair of read-modify-writes would
    // have dropped one.
    const ids = state.extraProviders.map((provider) => provider.id).sort()
    assert.deepEqual(ids, ['jan', 'ollama'])
    // And the op log shows strictly serialized read→write pairs.
    const pairOps = state.ops.filter(
      (op) => op === 'extraProviders' || op.startsWith('saveExtraProvider'),
    )
    assert.equal(pairOps.length, 4)
    for (let i = 0; i < pairOps.length; i += 2) {
      assert.equal(pairOps[i], 'extraProviders')
      assert.ok(pairOps[i + 1]?.startsWith('saveExtraProvider'))
    }
  })

  it('skips unselected and unreachable servers', async () => {
    state.servers = { ollama: ['llama'] }
    const api = stubApi(state)
    const findings = await runOnboardingScan(api)
    await importScanFindings(api, findings, {
      envKeyProviders: [],
      localServerIds: [],
      acpAgentIds: [],
    })
    assert.deepEqual(state.extraProviders, [])
  })

  it('writes the consent flag strictly before importing exactly the selected keys', async () => {
    state.envKeys = [envKey('anthropic'), envKey('openai')]
    const api = stubApi(state)
    const findings = await runOnboardingScan(api)
    await importScanFindings(api, findings, {
      envKeyProviders: ['anthropic'],
      localServerIds: [],
      acpAgentIds: [],
    })
    const consentIdx = state.ops.indexOf('set:envKeyAutoDetectEnabled')
    const importIdx = state.ops.indexOf('importEnvKeys')
    assert.ok(consentIdx !== -1 && importIdx !== -1 && consentIdx < importIdx)
    assert.equal(state.settings['envKeyAutoDetectEnabled'], true)
    assert.deepEqual(state.importedProviders, [['anthropic']])
  })

  it('writes no consent and never calls importEnvKeys when no keys are selected', async () => {
    state.envKeys = [envKey('anthropic')]
    const api = stubApi(state)
    const findings = await runOnboardingScan(api)
    await importScanFindings(api, findings, {
      envKeyProviders: [],
      localServerIds: [],
      acpAgentIds: [],
    })
    assert.equal(state.settings['envKeyAutoDetectEnabled'], undefined)
    assert.ok(!state.ops.includes('importEnvKeys'))
  })

  it('records selected installed agents in one merged write and never runs auto-setup', async () => {
    state.agents = [acpAgent('claude-code'), acpAgent('agent-two'), acpAgent('ghost', false)]
    state.settings['registeredAcpAgents'] = [
      { id: 'existing', title: 'Existing', command: 'existing', enabled: true },
    ]
    const api = stubApi(state)
    const findings = await runOnboardingScan(api)
    await importScanFindings(api, findings, {
      envKeyProviders: [],
      localServerIds: [],
      // ghost is not installed, so selecting it must be inert.
      acpAgentIds: ['claude-code', 'agent-two', 'ghost'],
    })
    const writes = state.ops.filter((op) => op === 'set:registeredAcpAgents')
    assert.equal(writes.length, 1)
    const agents = parseAcpAgentConfigs(state.settings['registeredAcpAgents'])
    assert.deepEqual(agents.map((agent) => agent.id).sort(), [
      'agent-two',
      'claude-code',
      'existing',
    ])
    assert.equal(state.autoSetupCalls, 0)
  })

  it('collects a failed phase as an error and still runs the rest', async () => {
    state.envKeys = [envKey('anthropic')]
    state.agents = [acpAgent('claude-code')]
    const api = stubApi(state)
    const findings = await runOnboardingScan(api)
    api.settings.importEnvKeys = async (): Promise<never> => {
      throw new Error('import blew up')
    }
    const result = await importScanFindings(api, findings, {
      envKeyProviders: ['anthropic'],
      localServerIds: [],
      acpAgentIds: ['claude-code'],
    })
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0] ?? '', /import blew up/)
    // The ACP phase still ran.
    const agents = parseAcpAgentConfigs(state.settings['registeredAcpAgents'])
    assert.deepEqual(
      agents.map((agent) => agent.id),
      ['claude-code'],
    )
  })
})

describe('deriveDefaultSettings', () => {
  const noSelection = { envKeyProviders: [], localServerIds: [], acpAgentIds: [] }

  it('every model value is a relative selector, never a fixed id', () => {
    for (const findings of [
      emptyFindings(),
      emptyFindings({
        lmStudio: { installed: true, serverUrl: 'http://x', running: true, models: [] },
      }),
    ]) {
      const defaults = deriveDefaultSettings(findings, noSelection)
      const fixedIds = new Set<string>(Object.values(LM_STUDIO_MODEL_IDS))
      for (const [key, value] of Object.entries(defaults)) {
        if (typeof value !== 'string') continue
        assert.ok(
          parseDynamicModel(value) !== null,
          `${key} should be a dynamic selector, got ${value}`,
        )
        assert.ok(!fixedIds.has(value), `${key} must not be a fixed LM Studio id`)
        assert.ok(!value.startsWith('lmstudio:'), `${key} must not pin an LM Studio model`)
      }
    }
  })

  it('chat default is balanced regardless of what was found', () => {
    assert.equal(
      deriveDefaultSettings(emptyFindings(), noSelection)['model'],
      BALANCED_MODEL_SELECTOR,
    )
  })

  it('with a running local server, local roles point at the best local model', () => {
    const defaults = deriveDefaultSettings(
      emptyFindings({
        lmStudio: { installed: true, serverUrl: 'http://x', running: true, models: [] },
      }),
      noSelection,
    )
    assert.equal(defaults['smallTasksModel'], 'auto:best-local')
    assert.equal(defaults['subagentModel'], 'auto:best-local')
    assert.equal(defaults['localSubagentsEnabled'], true)
    assert.equal(defaults['localTodoItemsEnabled'], true)
  })

  it('a reachable server only counts once the user left it selected', () => {
    const findings = emptyFindings({
      localServers: [{ id: 'jan', label: 'Jan', baseUrl: 'http://x', reachable: true, models: [] }],
    })
    const unselected = deriveDefaultSettings(findings, noSelection)
    assert.equal(unselected['localSubagentsEnabled'], false)
    const selected = deriveDefaultSettings(findings, { ...noSelection, localServerIds: ['jan'] })
    assert.equal(selected['localSubagentsEnabled'], true)
  })

  it('without local models, background roles fall back to cheap/threshold selectors', () => {
    const defaults = deriveDefaultSettings(emptyFindings(), noSelection)
    assert.equal(defaults['localDefaultModel'], 'auto:best-local')
    assert.equal(defaults['smallTasksModel'], 'auto:cheapest')
    assert.equal(defaults['subagentModel'], 'auto:min-intellect:30')
    assert.equal(defaults['localSubagentsEnabled'], false)
  })
})
