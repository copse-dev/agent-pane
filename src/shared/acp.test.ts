import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acpModelDisplayLabel, acpModelValue, isAcpModel, parseAcpModel } from './acp.ts'
import type { AcpAgentConfig } from './types/acp.ts'

describe('acp model values', () => {
  it('round-trips an agent id through acpModelValue/parseAcpModel', () => {
    assert.equal(acpModelValue('gemini-cli'), 'acp:gemini-cli')
    assert.equal(parseAcpModel('acp:gemini-cli'), 'gemini-cli')
    assert.equal(isAcpModel('acp:gemini-cli'), true)
  })

  it('returns null for non-acp models and the empty-id edge case', () => {
    assert.equal(parseAcpModel('claude-opus-4-8'), null)
    assert.equal(parseAcpModel('lmstudio:foo'), null)
    assert.equal(parseAcpModel('acp:'), null)
    assert.equal(isAcpModel('remote-agent:cursor'), false)
  })

  it('labels an acp model with the configured title, falling back to the id', () => {
    const agents: AcpAgentConfig[] = [
      { id: 'gemini-cli', title: 'Gemini CLI', command: 'gemini', enabled: true },
    ]
    assert.equal(acpModelDisplayLabel('acp:gemini-cli', agents), 'Gemini CLI')
    assert.equal(acpModelDisplayLabel('acp:unknown', agents), 'unknown')
    assert.equal(acpModelDisplayLabel('claude-opus-4-8', agents), 'claude-opus-4-8')
  })
})
