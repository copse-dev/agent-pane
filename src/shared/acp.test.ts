import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  acpModelDisplayLabel,
  acpModelValue,
  enabledClaudeAcpAgent,
  isAcpModel,
  isClaudeAcpAgent,
  parseAcpModel,
  parseAcpModelSelection,
} from './acp.ts'
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
    assert.equal(parseAcpModel('acp:#opus'), null)
    assert.equal(isAcpModel('remote-agent:cursor'), false)
  })

  it('encodes and decodes a specific model after the # separator', () => {
    // Model ids may contain [] , = but not #, so a first-# split is safe.
    const value = acpModelValue('cursor', 'composer-2.5[fast=true]')
    assert.equal(value, 'acp:cursor#composer-2.5[fast=true]')
    assert.deepEqual(parseAcpModelSelection(value), {
      id: 'cursor',
      model: 'composer-2.5[fast=true]',
    })
    // The routing id is still just the agent id.
    assert.equal(parseAcpModel(value), 'cursor')
    // No model → no model field.
    assert.deepEqual(parseAcpModelSelection('acp:cursor'), { id: 'cursor' })
  })

  it('labels an acp model with the configured title, falling back to the id', () => {
    const agents: AcpAgentConfig[] = [
      { id: 'gemini-cli', title: 'Gemini CLI', command: 'gemini', enabled: true },
    ]
    assert.equal(acpModelDisplayLabel('acp:gemini-cli', agents), 'Gemini CLI')
    assert.equal(acpModelDisplayLabel('acp:unknown', agents), 'unknown')
    assert.equal(acpModelDisplayLabel('claude-opus-4-8', agents), 'claude-opus-4-8')
  })

  it('labels a specific model as "Title — Model", resolving cached labels', () => {
    const agents: AcpAgentConfig[] = [
      {
        id: 'cursor',
        title: 'Cursor',
        command: 'cursor-agent',
        args: ['acp'],
        enabled: true,
        availableModels: [{ value: 'opus[]', label: 'Opus 4.8' }],
      },
    ]
    assert.equal(acpModelDisplayLabel('acp:cursor#opus[]', agents), 'Cursor — Opus 4.8')
    // Unknown model value falls back to the raw value after the title.
    assert.equal(acpModelDisplayLabel('acp:cursor#gpt-5.5', agents), 'Cursor — gpt-5.5')
  })
})

describe('Claude ACP agent preference', () => {
  it('matches the catalog commands that wrap Claude', () => {
    assert.equal(isClaudeAcpAgent({ command: 'claude-agent-acp' }), true)
    assert.equal(isClaudeAcpAgent({ command: 'claude-code-acp' }), true)
    // Other agents (Gemini, Cursor, Codex) are not Claude.
    assert.equal(isClaudeAcpAgent({ command: 'gemini' }), false)
    assert.equal(isClaudeAcpAgent({ command: 'cursor-agent' }), false)
    assert.equal(isClaudeAcpAgent({ command: 'codex-acp' }), false)
  })

  it('finds the first enabled Claude ACP agent, ignoring disabled ones', () => {
    const disabled: AcpAgentConfig = {
      id: 'claude',
      title: 'Claude',
      command: 'claude-agent-acp',
      enabled: false,
    }
    const enabled: AcpAgentConfig = {
      id: 'claude-zed',
      title: 'Claude Code (ACP, Zed)',
      command: 'claude-code-acp',
      enabled: true,
    }
    const gemini: AcpAgentConfig = {
      id: 'gemini-cli',
      title: 'Gemini CLI',
      command: 'gemini',
      enabled: true,
    }
    // No Claude agent at all → undefined.
    assert.equal(enabledClaudeAcpAgent([gemini]), undefined)
    // A Claude agent that is disabled does not count.
    assert.equal(enabledClaudeAcpAgent([disabled, gemini]), undefined)
    // An enabled Claude agent is returned.
    assert.equal(enabledClaudeAcpAgent([gemini, enabled]), enabled)
  })
})
