import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import '../../../../tests/setup-dom.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import type { DetectedAcpAgent, KnownAcpAgent } from '@shared/acp-known-agents.ts'
import type { AcpAgentConfig, AcpAuthState } from '@shared/types/acp.ts'
import { AGENT_LOGO_SVG } from './agent-logos.ts'
import { addableAgents, agentChip, createAcpAgentsList, listedAgents } from './acp-agents-list.ts'

function known(id: string, setup?: string): KnownAcpAgent {
  return { id, title: id.toUpperCase(), command: id, args: [], ...(setup ? { setup } : {}) }
}

function seen(k: KnownAcpAgent, installed: boolean): [string, DetectedAcpAgent] {
  return [k.id, { ...k, installed, path: installed ? `/bin/${k.command}` : null, running: false }]
}

const claude = known('claude', 'claude auth login')
const cursor = known('cursor', 'cursor-agent login')
const mine: AcpAgentConfig = { id: 'mine', title: 'Mine', command: 'mine', enabled: true }

describe('agentChip', () => {
  it('maps sign-in state and never claims a state it could not read', () => {
    assert.equal(agentChip('signed-in'), 'ready')
    assert.equal(agentChip('signed-out'), 'needs-sign-in')
    assert.equal(agentChip('unknown'), null)
    assert.equal(agentChip(undefined), null)
  })
})

describe('listedAgents', () => {
  it('lists installed agents and custom ones, and leaves uninstalled agents to the Add menu', () => {
    const detected = new Map([seen(claude, true), seen(cursor, false)])
    const auth = new Map<string, AcpAuthState>([['claude', 'signed-out']])
    const rows = listedAgents([claude, cursor], detected, [mine], auth)
    assert.deepEqual(
      rows.map((r) => r.id),
      ['claude', 'mine'],
    )
    assert.equal(rows[0]?.chip, 'needs-sign-in')
    assert.equal(rows[0].signInCommand, 'claude auth login')
    assert.equal(rows[1]?.chip, null)
    assert.equal(rows[1].signInCommand, null)
  })

  it('keeps an added agent listed even when it is not on PATH', () => {
    const added: AcpAgentConfig = {
      id: 'cursor',
      title: 'Cursor',
      command: 'cursor',
      enabled: true,
    }
    const detected = new Map([seen(cursor, false)])
    assert.deepEqual(
      listedAgents([cursor], detected, [added], new Map()).map((r) => r.id),
      ['cursor'],
    )
  })
})

describe('addableAgents', () => {
  it('offers only agents that are neither installed nor added', () => {
    const detected = new Map([seen(claude, true), seen(cursor, false)])
    assert.deepEqual(
      addableAgents([claude, cursor], detected, []).map((k) => k.id),
      ['cursor'],
    )
  })
})

describe('createAcpAgentsList (rendered)', () => {
  it('shows an installed signed-out agent with its chip on the name row, and buries the rest', async () => {
    const base = createFakeApi()
    const codex = KNOWN_ACP_AGENTS.find((k) => k.id === 'codex-acp')
    assert.ok(codex)
    const api: ApiClient = {
      ...base,
      settings: { ...base.settings, get: async () => [] },
      acp: {
        ...base.acp,
        detectAgents: async () =>
          KNOWN_ACP_AGENTS.map((k) => ({
            ...k,
            installed: k.id === 'codex-acp',
            path: k.id === 'codex-acp' ? '/bin/codex-acp' : null,
            running: false,
          })),
        authStatus: async () => [{ id: 'codex-acp', state: 'signed-out' as const }],
      },
    }
    const list = createAcpAgentsList(api)
    document.body.append(list.root)
    await list.refresh()

    const rows = [...list.root.querySelectorAll('.acp-list > .acp-row')]
    assert.deepEqual(
      rows.map((r) => r.getAttribute('data-agent')),
      ['codex-acp'],
    )
    const row = rows[0]
    assert.ok(row)
    assert.ok(row.querySelector('.acp-logo svg'), 'brand logo is rendered')
    assert.equal(row.querySelector('.acp-row-name .acp-row-chip')?.textContent, 'Needs sign-in')

    // Uninstalled agents appear only once "+ Add an agent" is opened.
    assert.equal(list.root.querySelectorAll('.acp-add-row').length, 0)
    list.root.querySelector<HTMLButtonElement>('[data-testid="acp-add-toggle"]')?.click()
    const added = [...list.root.querySelectorAll('.acp-add-row')].map((r) =>
      r.getAttribute('data-agent'),
    )
    assert.ok(added.includes('cursor') && !added.includes('codex-acp'))
    list.root.remove()
  })
})

describe('agent logos', () => {
  it('declare the SVG namespace, or DOMParser yields an element that never paints', () => {
    for (const [brand, svg] of Object.entries(AGENT_LOGO_SVG)) {
      assert.match(svg, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, brand)
    }
  })
})
