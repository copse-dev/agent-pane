import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, DetectedEnvKey } from '../../../preload/api.d.ts'
import type { AcpAgentConfig, AcpAuthState, AcpAutoSetupResult } from '@shared/types/acp.ts'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { BUILTIN_EXTRA_PROVIDERS } from '@copse/llm/extra-providers.ts'
import { DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'
import { el } from '../../dom/helpers.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
} from '../confirm-dialog.ts'
import {
  connectionRows,
  createModelsAgentsList,
  type ModelsAgentsListOptions,
} from './models-agents-list.ts'

interface State {
  settings: Record<string, unknown>
  /** Stored keys; the value is whether the key is OS-encrypted. */
  keys: Map<string, boolean>
  installed: Set<string>
  auth: Map<string, AcpAuthState>
  agents: AcpAgentConfig[]
  /** Base URLs that answer a model listing. */
  servers: Set<string>
  validate: (provider: string) => boolean
  validated: [string, string][]
  stored: [string, string][]
  autoSetupCalls: number
  scans: number
  imports: number
  found: { provider: string; alreadyConfigured: boolean }[]
}

function stubApi(state: State): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base.settings,
      get: async (key) =>
        key === 'registeredAcpAgents' ? state.agents : (state.settings[key] ?? null),
      set: async (key, value): Promise<void> => {
        state.settings[key] = value
      },
      getKey: async (provider) => state.keys.has(provider),
      getKeyEncrypted: async (provider) => state.keys.get(provider) ?? null,
      setKey: async (provider, key): Promise<{ ok: true }> => {
        state.stored.push([provider, key])
        if (key) state.keys.set(provider, true)
        else state.keys.delete(provider)
        return { ok: true }
      },
      validateKey: async (provider, key): Promise<{ ok: boolean; error?: string }> => {
        state.validated.push([provider, key])
        return state.validate(provider) ? { ok: true } : { ok: false, error: 'Key rejected' }
      },
      extraProviders: async () => [...BUILTIN_EXTRA_PROVIDERS],
      scanEnvKeys: async (): Promise<DetectedEnvKey[]> => {
        state.scans += 1
        return state.found.map((entry) => ({
          provider: entry.provider,
          envVar: `${entry.provider.toUpperCase()}_API_KEY`,
          source: '~/.zshrc',
          masked: 'sk-…abcd',
          alreadyConfigured: entry.alreadyConfigured,
        }))
      },
      importEnvKeys: async (
        providers,
      ): Promise<{
        imported: { provider: string; source: string }[]
        skipped: { provider: string; reason: string }[]
      }> => {
        state.imports += 1
        const imported = (providers ?? []).map((provider) => {
          state.keys.set(provider, true)
          return { provider, source: '~/.zshrc' }
        })
        return { imported, skipped: [] }
      },
    },
    acp: {
      ...base.acp,
      detectAgents: async () =>
        KNOWN_ACP_AGENTS.map((k) => ({
          ...k,
          installed: state.installed.has(k.id),
          path: state.installed.has(k.id) ? `/bin/${k.command}` : null,
          running: false,
        })),
      authStatus: async (ids) =>
        ids.map((id) => ({ id, state: state.auth.get(id) ?? ('unknown' as const) })),
      autoSetup: async (): Promise<AcpAutoSetupResult> => {
        state.autoSetupCalls += 1
        return { installed: [], upgraded: [], registered: [], modelsDetected: [], failed: [] }
      },
    },
    lmStudio: {
      ...base.lmStudio,
      test: async (url) =>
        state.servers.has(url) ? { ok: true, models: ['m'] } : { ok: false, error: 'down' },
    },
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await tick()
}

function rowIds(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.acp-list > .acp-row')].map(
    (row) => row.dataset['row'] ?? '',
  )
}

function rowEl(root: HTMLElement, id: string): HTMLElement {
  const row = root.querySelector<HTMLElement>(`.acp-list > .acp-row[data-row="${id}"]`)
  assert.ok(row, `expected row ${id}, got ${JSON.stringify(rowIds(root))}`)
  return row
}

function button(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent.trim() === text,
  )
  assert.ok(found, `expected a "${text}" button`)
  return found
}

const ollamaUrl = BUILTIN_EXTRA_PROVIDERS.find((p) => p.id === 'ollama')?.baseUrl ?? ''

describe('connectionRows', () => {
  it('groups each company, then other agents, other keys and model servers', () => {
    assert.deepEqual(
      connectionRows(
        ['qwen-code', 'claude-acp', 'codex-acp'],
        ['openrouter', 'anthropic', 'openai', 'cursor'],
        ['ollama'],
      ).map((row) => `${row.kind}:${row.id}`),
      [
        'plan:chatgpt',
        'agent:codex-acp',
        'key:openai',
        'agent:claude-acp',
        'key:anthropic',
        'key:cursor',
        'agent:qwen-code',
        'key:openrouter',
        'server:ollama',
      ],
    )
  })
})

describe('Models & agents list', () => {
  let state: State

  beforeEach(() => {
    document.body.innerHTML = ''
    mountConfirmDialog()
    state = {
      settings: {},
      keys: new Map(),
      installed: new Set(),
      auth: new Map(),
      agents: [],
      servers: new Set(),
      validate: (): boolean => true,
      validated: [],
      stored: [],
      autoSetupCalls: 0,
      scans: 0,
      imports: 0,
      found: [],
    }
  })

  async function mount(
    opts: ModelsAgentsListOptions = {},
  ): Promise<ReturnType<typeof createModelsAgentsList>> {
    const list = createModelsAgentsList(stubApi(state), opts)
    const form = el('form', {}, list.root)
    document.body.append(form)
    await list.refresh()
    await settle()
    return list
  }

  it('shows agents, keys and running model servers as one grouped list', async () => {
    state.installed = new Set(['codex-acp', 'claude-acp'])
    state.auth = new Map([
      ['codex-acp', 'signed-out'],
      ['claude-acp', 'signed-in'],
    ])
    state.keys = new Map([
      ['openai', true],
      ['openrouter', false],
    ])
    state.servers = new Set([ollamaUrl])
    const list = await mount()

    assert.deepEqual(rowIds(list.root), [
      'plan:chatgpt',
      'agent:codex-acp',
      'key:openai',
      'agent:claude-acp',
      'key:openrouter',
      'server:ollama',
    ])
    const codex = rowEl(list.root, 'agent:codex-acp')
    assert.ok(codex.querySelector('.acp-logo svg'), 'brand logo is rendered')
    assert.equal(codex.querySelector('.acp-row-chip')?.textContent, 'Needs sign-in')
    assert.equal(
      rowEl(list.root, 'agent:claude-acp').querySelector('.acp-row-chip')?.textContent,
      'Ready',
    )
    const openai = rowEl(list.root, 'key:openai')
    assert.match(openai.textContent, /OpenAI API key/)
    assert.match(openai.textContent, /Saved/)
    assert.match(openai.textContent, /encrypted by your system keychain/)
    assert.match(rowEl(list.root, 'key:openrouter').textContent, /stored unencrypted/)
    assert.match(rowEl(list.root, 'server:ollama').textContent, /Running/)
    // Secrets never reach the renderer, so nothing key-like is shown.
    assert.doesNotMatch(list.root.textContent, /sk-/)
  })

  it('lists a saved key as Saved even when its at-rest state is unknown', async () => {
    state.keys = new Map([['anthropic', true]])
    const base = stubApi(state)
    const list = createModelsAgentsList({
      ...base,
      settings: { ...base.settings, getKeyEncrypted: async () => null },
    })
    document.body.append(list.root)
    await list.refresh()
    await settle()
    const row = rowEl(list.root, 'key:anthropic')
    assert.equal(row.querySelector('.acp-row-chip')?.textContent, 'Saved')
    assert.doesNotMatch(row.textContent, /Custom|no key saved|unencrypted/)
    assert.ok(button(row, 'Remove'))
  })

  it('signs an agent in through a terminal, or copies the command without one', async () => {
    state.installed = new Set(['codex-acp'])
    state.auth = new Map([['codex-acp', 'signed-out']])
    const ran: string[] = []
    const list = await mount({ runInTerminal: (command) => ran.push(command) })
    const signIn = button(rowEl(list.root, 'agent:codex-acp'), 'Sign in')
    signIn.click()
    assert.deepEqual(ran, ['codex login'])
    assert.equal(signIn.textContent, 'Opened in a terminal…')
    list.reset()

    document.body.innerHTML = ''
    const copying = await mount()
    assert.ok(button(rowEl(copying.root, 'agent:codex-acp'), 'Copy sign-in command'))
    copying.reset()
  })

  it('installs a missing agent from the Add menu in a terminal', async () => {
    const ran: string[] = []
    const list = await mount({ runInTerminal: (command) => ran.push(command) })
    button(list.root, '+ Add').click()
    const menu = list.root.querySelector<HTMLElement>('[data-testid="connections-add-menu"]')
    assert.ok(menu && !menu.hidden)
    const gemini = menu.querySelector<HTMLElement>('.acp-add-row[data-agent="gemini"]')
    assert.ok(gemini)
    assert.match(gemini.textContent, /npm install -g @google\/gemini-cli/)
    button(gemini, 'Install').click()
    assert.deepEqual(ran, ['npm install -g @google/gemini-cli'])
    list.reset()
  })

  it('removes a key only after confirmation', async () => {
    state.keys = new Map([['openrouter', true]])
    let changed = 0
    const list = await mount({ onKeysChanged: () => (changed += 1) })

    button(rowEl(list.root, 'key:openrouter'), 'Remove').click()
    await tick()
    clickActiveConfirmDialogCancel()
    await settle()
    assert.deepEqual(state.stored, [])
    assert.ok(rowEl(list.root, 'key:openrouter'))

    button(rowEl(list.root, 'key:openrouter'), 'Remove').click()
    await tick()
    clickActiveConfirmDialogConfirm()
    await settle()
    assert.deepEqual(state.stored, [['openrouter', '']])
    assert.equal(list.root.querySelector('[data-row="key:openrouter"]'), null)
    assert.equal(changed, 1)
  })

  it('shows the key form and the OpenAI tier under the OpenAI key Options', async () => {
    state.keys = new Map([['openai', true]])
    state.settings['openAiServiceTier'] = 'priority'
    const list = await mount()
    button(rowEl(list.root, 'key:openai'), 'Options').click()
    const row = rowEl(list.root, 'key:openai')
    assert.ok(row.querySelector('[data-provider-key-status="openai"]'))
    const tier = row.querySelector<HTMLSelectElement>('[name="openAiServiceTier"]')
    assert.ok(tier)
    assert.equal(tier.value, 'fast')
    tier.value = 'flex'
    tier.dispatchEvent(new Event('change', { bubbles: true }))
    assert.deepEqual(list.readUpdate(), { openAiServiceTier: 'flex' })
    button(row, 'Hide options').click()
    assert.equal(rowEl(list.root, 'key:openai').querySelector('.acp-row-options'), null)
  })

  it('keeps cloud-agent run options in the form whether or not they are shown', async () => {
    state.keys = new Map([['anthropic', true]])
    const templates = el('div', { hidden: true })
    const claude = el('div', { id: 'claude-auth' })
    const options = el(
      'div',
      { id: 'cloud-options' },
      el('input', { type: 'checkbox', name: 'remoteAgentAutoCreatePR' }),
    )
    templates.append(claude, options)
    const list = createModelsAgentsList(stubApi(state), {
      cloudAgents: [{ provider: 'anthropic', element: claude }],
      cloudAgentOptions: options,
    })
    const form = el('form', {}, list.root, templates)
    document.body.append(form)
    await list.refresh()
    await settle()
    const inForm = (): boolean => !!form.elements.namedItem('remoteAgentAutoCreatePR')

    assert.equal(inForm(), true)
    button(rowEl(list.root, 'key:anthropic'), 'Options').click()
    const row = rowEl(list.root, 'key:anthropic')
    assert.ok(row.querySelector('#claude-auth'), 'the cloud agent auth panel shows')
    assert.ok(row.contains(options))
    assert.equal(options.hidden, false)
    assert.equal(inForm(), true)

    button(row, 'Hide options').click()
    assert.equal(options.hidden, true)
    assert.ok(templates.contains(options), 'run options return to the host form')
    assert.equal(inForm(), true)
    list.reset()
  })

  it('adds a pasted key after the provider accepts it, and reports a rejection', async () => {
    let changed = 0
    const list = await mount({ onKeysChanged: () => (changed += 1) })
    button(list.root, '+ Add').click()
    button(list.root, 'Add key').click()
    const input = list.root.querySelector<HTMLInputElement>('[data-testid="paste-key-input"]')
    assert.ok(input)

    state.validate = (): boolean => false
    input.value = 'sk-or-v1-rejected'
    input.dispatchEvent(new Event('input'))
    list.root.querySelector<HTMLButtonElement>('[data-testid="paste-key-save"]')?.click()
    await settle()
    assert.deepEqual(state.stored, [])
    assert.match(
      list.root.querySelector('[data-testid="paste-key-hint"]')?.textContent ?? '',
      /Key rejected/,
    )

    state.validate = (): boolean => true
    input.value = 'sk-or-v1-accepted'
    input.dispatchEvent(new Event('input'))
    list.root.querySelector<HTMLButtonElement>('[data-testid="paste-key-save"]')?.click()
    await settle()
    assert.deepEqual(state.stored, [['openrouter', 'sk-or-v1-accepted']])
    assert.ok(rowEl(list.root, 'key:openrouter'))
    assert.equal(changed, 1)
  })

  it('offers Cursor as a pasted-key provider for its cloud agent', async () => {
    const list = await mount()
    button(list.root, '+ Add').click()
    button(list.root, 'Add key').click()
    const providers = [
      ...list.root.querySelectorAll<HTMLOptionElement>('[data-testid="paste-key-provider"] option'),
    ].map((option) => option.value)
    assert.ok(providers.includes('cursor'))
    assert.ok(providers.includes('anthropic'))
  })

  it('connects a model server through its own form, or a custom URL', async () => {
    state.servers = new Set([ollamaUrl])
    const list = await mount()
    button(list.root, '+ Add').click()
    button(list.root, 'Connect').click()
    const choice = list.root.querySelector<HTMLSelectElement>(
      '[data-testid="connections-server-choice"]',
    )
    assert.ok(choice)
    const values = [...choice.options].map((option) => option.value)
    assert.ok(!values.includes('ollama'), 'a running server is already listed')
    assert.ok(values.includes('llamacpp'))
    assert.equal(values.at(-1), 'other')
    choice.value = 'llamacpp'
    choice.dispatchEvent(new Event('change'))
    assert.match(list.root.textContent, /Fetch models/)

    const again = list.root.querySelector<HTMLSelectElement>(
      '[data-testid="connections-server-choice"]',
    )
    assert.ok(again)
    again.value = 'other'
    again.dispatchEvent(new Event('change'))
    assert.match(list.root.textContent, /Add a provider/)
  })

  it('probes LM Studio at its saved address', async () => {
    state.settings['localServerUrl'] = 'http://127.0.0.1:4321/v1'
    state.servers = new Set(['http://127.0.0.1:4321/v1'])
    const lmStudio = el('div', { id: 'lm-studio-form' })
    const list = await mount({
      nativeLocalProviders: [{ id: 'lmstudio', label: 'LM Studio', element: lmStudio }],
    })
    assert.ok(rowIds(list.root).includes('server:lmstudio'))
    button(rowEl(list.root, 'server:lmstudio'), 'Options').click()
    assert.ok(rowEl(list.root, 'server:lmstudio').contains(lmStudio), 'its own form opens')
    assert.notEqual(DEFAULT_LM_STUDIO_URL, 'http://127.0.0.1:4321/v1')
  })

  it('edits a custom agent without requesting unrelated preset installations', async () => {
    state.agents = [{ id: 'mine', title: 'Mine', command: 'mine', enabled: true }]
    const list = await mount()
    button(rowEl(list.root, 'agent:mine'), 'Options').click()
    await tick()
    assert.ok(list.root.querySelector('.acp-agent-card'))
    assert.equal(state.autoSetupCalls, 0)
    list.reset()
  })

  it('does not nest a second Re-scan action inside an agent row’s Options', async () => {
    state.agents = [{ id: 'mine', title: 'Mine', command: 'mine', enabled: true }]
    const list = await mount()
    const row = rowEl(list.root, 'agent:mine')
    button(row, 'Options').click()
    await tick()
    const nested = [...row.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Re-scan device',
    )
    assert.equal(nested, undefined, 'the row options must not duplicate the single Re-scan above')
    list.reset()
  })

  describe('Re-scan (agents, servers and keys in one click)', () => {
    function status(root: HTMLElement): string {
      return root.querySelector('[data-testid="connections-scan-status"]')?.textContent ?? ''
    }

    it('imports new keys it finds and says how many were added', async () => {
      state.found = [
        { provider: 'groq', alreadyConfigured: false },
        { provider: 'mistral', alreadyConfigured: false },
      ]
      let changed = 0
      const list = await mount({ onKeysChanged: () => (changed += 1) })
      button(list.root, 'Re-scan').click()
      await settle()
      assert.equal(state.settings['envKeyAutoDetectEnabled'], true)
      assert.equal(state.imports, 1)
      assert.equal(changed, 1)
      assert.match(status(list.root), /Added 2 keys found on this machine/)
      assert.ok(rowEl(list.root, 'key:groq'))
      assert.ok(rowEl(list.root, 'key:mistral'))
    })

    it('never overwrites a key that is already configured', async () => {
      state.found = [{ provider: 'openai', alreadyConfigured: true }]
      const list = await mount()
      button(list.root, 'Re-scan').click()
      await settle()
      assert.equal(state.imports, 0)
      assert.match(status(list.root), /Nothing new found/)
    })

    it('never reads keys on a background re-check', async () => {
      state.found = [{ provider: 'groq', alreadyConfigured: false }]
      const list = await mount()
      window.dispatchEvent(new Event('focus'))
      await settle()
      assert.equal(state.scans, 0)
      assert.equal(state.settings['envKeyAutoDetectEnabled'], undefined)
      list.reset()
    })
  })
})
