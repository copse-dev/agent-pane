import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../settings.ts'
import {
  getAcpAgent,
  listAcpAgents,
  listEnabledAcpAgents,
  resolveAcpSandbox,
} from './acp-agent-registry.ts'

describe('acp agent registry', () => {
  beforeEach(async () => {
    await setSetting('registeredAcpAgents', [])
  })

  it('lists configured agents and offers only the enabled ones', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'gemini', title: 'Gemini CLI', command: 'gemini', enabled: true },
      { id: 'old', title: 'Old Agent', command: 'old', enabled: false },
    ])

    assert.equal(listAcpAgents().length, 2)
    assert.deepEqual(
      listEnabledAcpAgents().map((agent) => agent.id),
      ['gemini'],
    )
  })

  it('resolves an enabled agent by id and fails closed otherwise', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'gemini', title: 'Gemini CLI', command: 'gemini', args: ['--acp'], enabled: true },
      { id: 'disabled', title: 'Disabled', command: 'x', enabled: false },
    ])

    assert.deepEqual(getAcpAgent('gemini')?.args, ['--acp'])
    assert.equal(getAcpAgent('disabled'), null) // disabled → not spawnable
    assert.equal(getAcpAgent('missing'), null)
  })

  it('returns an empty list when nothing is configured', () => {
    assert.deepEqual(listAcpAgents(), [])
    assert.deepEqual(listEnabledAcpAgents(), [])
    assert.equal(getAcpAgent('anything'), null)
  })
})

describe('resolveAcpSandbox (issue #590)', () => {
  const base = { title: 'X', command: 'x', enabled: true }

  it('falls back to the KNOWN_ACP_AGENTS catalog preset for the id', () => {
    const resolved = resolveAcpSandbox({ ...base, id: 'claude-agent-acp' })
    assert.ok(resolved)
    assert.ok(resolved.allowedDomains.includes('api.anthropic.com'))
    assert.ok(resolved.homeDirs?.includes('.claude'))
  })

  it('prefers an explicit per-config override to the catalog preset', () => {
    const custom = { allowedDomains: ['example.com'] }
    assert.deepEqual(
      resolveAcpSandbox({ ...base, id: 'claude-agent-acp', sandbox: custom }),
      custom,
    )
  })

  it('honors sandbox: false as an explicit opt-out', () => {
    assert.equal(resolveAcpSandbox({ ...base, id: 'claude-agent-acp', sandbox: false }), undefined)
  })

  it('leaves agents with no catalog preset unsandboxed', () => {
    assert.equal(resolveAcpSandbox({ ...base, id: 'my-custom-agent' }), undefined)
    assert.equal(resolveAcpSandbox({ ...base, id: 'cursor' }), undefined) // preset ships no sandbox
  })
})
