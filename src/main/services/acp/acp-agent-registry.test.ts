import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../settings.ts'
import { getAcpAgent, listAcpAgents, listEnabledAcpAgents } from './acp-agent-registry.ts'

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
