import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  acpModelChoiceLabel,
  acpModelDisplayLabel,
  acpModelValue,
  acpModelVersionName,
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
    assert.equal(acpModelDisplayLabel('acp:cursor#opus[]', agents), 'Cursor — Claude Opus 4.8')
    // Unknown model value falls back to the raw value after the title.
    assert.equal(acpModelDisplayLabel('acp:cursor#gpt-5.5', agents), 'Cursor — gpt-5.5')
  })

  it('folds a description-only version into the label', () => {
    const agents: AcpAgentConfig[] = [
      {
        id: 'claude-agent-acp',
        title: 'Claude',
        command: 'claude-agent-acp',
        enabled: true,
        availableModels: [
          { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine' },
        ],
      },
    ]
    assert.equal(
      acpModelDisplayLabel('acp:claude-agent-acp#sonnet', agents),
      'Claude — Claude Sonnet 5',
    )
  })
})

describe('acp model choice labels', () => {
  it('reads the version an agent keeps in the description', () => {
    assert.equal(acpModelVersionName('Sonnet 5 · Efficient for routine tasks'), 'Sonnet 5')
    // The variant tail is dropped — the agent's own label already carries it.
    assert.equal(acpModelVersionName('Opus 5 with 1M context · Best for everyday'), 'Opus 5')
    assert.equal(acpModelVersionName('Haiku 4.5 · Fastest for quick answers'), 'Haiku 4.5')
  })

  it('ignores prose descriptions and missing ones', () => {
    assert.equal(acpModelVersionName(undefined), null)
    assert.equal(acpModelVersionName('Standard Claude Code agent'), null)
    assert.equal(
      acpModelVersionName('A general model tuned for 3 kinds of long-running agentic work'),
      null,
    )
  })

  it('slots the version into a label that names the same family', () => {
    const label = (l: string, description?: string): string =>
      acpModelChoiceLabel({ value: 'v', label: l, ...(description ? { description } : {}) })
    // The finished label is spelled the app's way, whichever way the agent
    // spelled its half of it.
    assert.equal(label('Sonnet', 'Sonnet 5 · Efficient'), 'Claude Sonnet 5')
    assert.equal(
      label('Opus (1M context)', 'Opus 5 with 1M context · Best'),
      'Claude Opus 5 (1M context)',
    )
    // A label naming something else gets the model it resolves to appended.
    assert.equal(
      label('Default (recommended)', 'Opus 5 with 1M context · Best'),
      'Default (recommended) — Claude Opus 5',
    )
    // Already-versioned labels, family prefixes that only look alike, and
    // choices without a description keep their own shape.
    assert.equal(label('Opus 5', 'Opus 5 · Best'), 'Claude Opus 5')
    assert.equal(label('Opusine', 'Opus 5 · Best'), 'Opusine — Claude Opus 5')
    assert.equal(label('gpt-5.5'), 'gpt-5.5')
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
