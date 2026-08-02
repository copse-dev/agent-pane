import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, ExtraProvider } from '../../../preload/api.d.ts'
import type { AcpAgentConfig, AcpAutoSetupResult } from '@shared/types/acp.ts'
import type { DetectedAcpAgent } from '@shared/acp-known-agents.ts'
import { createProvidersPanel } from './providers-section.ts'
import { el } from '../../dom/helpers.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'

interface StubState {
  settings: Record<string, unknown>
  keys: Record<string, string>
  extraProviders: ExtraProvider[]
  agents: AcpAgentConfig[]
  detectCalls: number
  autoSetupCalls: number
}

function stubApi(state: StubState): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base.settings,
      get: async (key: string): Promise<unknown> =>
        key === 'registeredAcpAgents' ? state.agents : (state.settings[key] ?? null),
      set: async (key: string, value: unknown): Promise<void> => {
        state.settings[key] = value
      },
      getKey: async (slug: string): Promise<boolean> => Boolean(state.keys[slug]),
      extraProviders: async (): Promise<ExtraProvider[]> => state.extraProviders,
    },
    acp: {
      ...base.acp,
      detectAgents: async (): Promise<DetectedAcpAgent[]> => {
        state.detectCalls += 1
        return []
      },
      autoSetup: async (): Promise<AcpAutoSetupResult> => {
        state.autoSetupCalls += 1
        return {
          installed: [],
          upgraded: [],
          registered: [],
          modelsDetected: [],
          failed: [],
        }
      },
    },
  } satisfies ApiClient
}

function chips(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.provider-chip')].map(
    (chip) => chip.dataset['provider'] ?? '',
  )
}

function capabilityTitles(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.provider-capability-title')].map((title) =>
    title.textContent.trim(),
  )
}

function clickChip(root: HTMLElement, provider: string): void {
  const chip = root.querySelector<HTMLElement>(`.provider-chip[data-provider="${provider}"]`)
  assert.ok(chip, `expected a ${provider} chip, got ${JSON.stringify(chips(root))}`)
  chip.dispatchEvent(new Event('click'))
}

const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

describe('providers panel', () => {
  let state: StubState

  beforeEach(() => {
    document.body.innerHTML = ''
    state = {
      settings: {},
      keys: {},
      extraProviders: [],
      agents: [],
      detectCalls: 0,
      autoSetupCalls: 0,
    }
  })

  it('opens on the provider list with none of them expanded', async () => {
    state.keys['anthropic'] = 'sk-ant-test'
    const panel = createProvidersPanel(stubApi(state), {})
    document.body.append(panel.root)
    await panel.refresh()

    // A configured provider still does not open itself: the panel is a list you
    // choose from, not a form for whichever provider happens to sort first.
    assert.ok(chips(panel.root).includes('anthropic'))
    assert.deepEqual(capabilityTitles(panel.root), [])
    assert.equal(panel.root.querySelector('.provider-chip.active'), null)

    clickChip(panel.root, 'anthropic')
    assert.ok(capabilityTitles(panel.root).length > 0)
  })

  it('gives a provider one chip covering its cloud agent and its device agent', async () => {
    const panel = createProvidersPanel(stubApi(state), {
      cloudAgents: [
        { vendor: 'cursor', element: el('div', { id: 'cursor-auth' }), keySlugs: ['cursor'] },
      ],
    })
    document.body.append(panel.root)
    await panel.refresh()

    // Cursor sells both, so it is one chip, not two entries in two sections.
    assert.equal(chips(panel.root).filter((id) => id === 'cursor').length, 1)

    clickChip(panel.root, 'cursor')
    assert.deepEqual(capabilityTitles(panel.root), ['Cloud agent', 'On this machine'])
    assert.ok(panel.root.querySelector('#cursor-auth'), 'the cloud agent auth panel should show')
  })

  it('stacks an API key, a cloud agent, and a device agent under one provider', async () => {
    const panel = createProvidersPanel(stubApi(state), {
      cloudAgents: [
        {
          vendor: 'anthropic',
          element: el('div', { id: 'claude-auth' }),
          keySlugs: ['anthropic', 'github'],
        },
      ],
    })
    document.body.append(panel.root)
    await panel.refresh()

    clickChip(panel.root, 'anthropic')
    assert.deepEqual(capabilityTitles(panel.root), ['API key', 'Cloud agent', 'On this machine'])
  })

  it('marks a provider as set up when any one of its capabilities is', async () => {
    state.keys['anthropic'] = 'sk-ant-test'
    const panel = createProvidersPanel(stubApi(state), {})
    document.body.append(panel.root)
    await panel.refresh()

    const anthropic = panel.root.querySelector('.provider-chip[data-provider="anthropic"]')
    const openai = panel.root.querySelector('.provider-chip[data-provider="openai"]')
    assert.ok(anthropic?.querySelector('.provider-chip-dot'))
    assert.equal(openai?.querySelector('.provider-chip-dot'), null)
  })

  it('keeps the cloud-agent run options in the form, hidden until one is selected', async () => {
    const options = el(
      'div',
      { id: 'cloud-options' },
      el('input', { type: 'checkbox', name: 'remoteAgentAutoCreatePR' }),
    )
    const form = el('form', {})
    const panel = createProvidersPanel(stubApi(state), {
      cloudAgents: [{ vendor: 'cursor', element: el('div', {}), keySlugs: ['cursor'] }],
      cloudAgentOptions: options,
    })
    form.append(panel.root)
    document.body.append(form)
    await panel.refresh()

    // Whatever is selected, the controls stay in the form's control list so a
    // save reads their real values rather than treating them as absent (which
    // for a checkbox silently means "off").
    const inForm = (): boolean => !!form.elements.namedItem('remoteAgentAutoCreatePR')

    clickChip(panel.root, 'openai')
    assert.equal(options.hidden, true)
    assert.equal(inForm(), true)

    clickChip(panel.root, 'cursor')
    assert.equal(options.hidden, false)
    assert.equal(inForm(), true)
  })

  it('holds auto-setup back until the user picks a provider that has an agent', async () => {
    const panel = createProvidersPanel(stubApi(state), {})
    document.body.append(panel.root)
    await panel.refresh()
    await flush()

    // Opening settings may scan so the installed badge is honest, but must not
    // reach auto-setup, which can install adapters the user never asked for.
    assert.equal(state.autoSetupCalls, 0)

    // Nor does picking a provider that only has an API key.
    clickChip(panel.root, 'openrouter')
    await flush()
    assert.equal(state.autoSetupCalls, 0)

    clickChip(panel.root, 'anthropic')
    await flush()
    assert.equal(state.autoSetupCalls, 1)

    // Once run, it does not run again while the dialog stays mounted.
    clickChip(panel.root, 'openai')
    await flush()
    assert.equal(state.autoSetupCalls, 1)
  })

  it('offers one Add flow that routes to the right kind of provider', async () => {
    const panel = createProvidersPanel(stubApi(state), {})
    document.body.append(panel.root)
    await panel.refresh()

    clickChip(panel.root, 'other')
    const kind = panel.root.querySelector('select')
    assert.ok(kind)
    assert.deepEqual(
      [...kind.options].map((option) => option.value),
      ['api', 'local', 'agent'],
    )
    assert.match(panel.root.textContent, /Add a provider/)

    kind.value = 'agent'
    kind.dispatchEvent(new Event('change'))
    assert.match(panel.root.textContent, /Add a custom agent/)
  })
})
