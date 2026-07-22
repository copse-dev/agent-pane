import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CURSOR_AGENTS_WEB_URL,
  MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT,
  isRemoteAgentModel,
  parseRemoteAgentModel,
  parseRemoteAgentModelSelection,
  remoteAgentDisplayLabel,
  remoteAgentGroupLabel,
  remoteAgentModelValue,
  resolveManagedAgentModelId,
} from './remote-agent.ts'
import { DEFAULT_MANAGED_AGENT_MODEL } from './managed-agents.ts'

describe('CURSOR_AGENTS_WEB_URL', () => {
  it('points at the Cursor agents list (API source filter lives there)', () => {
    assert.equal(CURSOR_AGENTS_WEB_URL, 'https://cursor.com/agents')
  })
})

describe('remote-agent model selection', () => {
  it('encodes and parses provider-only and provider#model values', () => {
    assert.equal(remoteAgentModelValue('cursor'), 'remote-agent:cursor')
    assert.equal(remoteAgentModelValue('cursor', 'composer-2'), 'remote-agent:cursor#composer-2')
    assert.deepEqual(parseRemoteAgentModelSelection('remote-agent:cursor'), {
      provider: 'cursor',
    })
    assert.deepEqual(parseRemoteAgentModelSelection('remote-agent:cursor#composer-2'), {
      provider: 'cursor',
      model: 'composer-2',
    })
    assert.equal(parseRemoteAgentModel('remote-agent:anthropic#claude-opus-4-8'), 'anthropic')
    assert.equal(parseRemoteAgentModelSelection('remote-agent:unknown'), null)
    assert.equal(parseRemoteAgentModelSelection('claude-sonnet-4-6'), null)
    assert.equal(isRemoteAgentModel('remote-agent:anthropic#claude-haiku-4-5'), true)
  })

  it('keeps Claude Managed Agents picker ids aligned with tracked cloud Claude models', () => {
    assert.ok(MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT.includes(DEFAULT_MANAGED_AGENT_MODEL))
    assert.ok(MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT.includes('claude-sonnet-4-6'))
    assert.ok(MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT.includes('claude-haiku-4-5'))
    assert.ok(!MANAGED_AGENT_PICKER_MODELS_WITH_DEFAULT.some((id) => id.startsWith('gpt')))
  })

  it('resolves Managed Agents model id with the create-agent default', () => {
    assert.equal(resolveManagedAgentModelId({ provider: 'anthropic' }), DEFAULT_MANAGED_AGENT_MODEL)
    assert.equal(
      resolveManagedAgentModelId({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
      'claude-sonnet-4-6',
    )
  })

  it('labels selections with per-provider group titles', () => {
    assert.equal(remoteAgentGroupLabel('cursor'), 'Cursor Cloud Agent')
    assert.equal(remoteAgentGroupLabel('anthropic'), 'Claude Cloud Agent')
    assert.equal(remoteAgentDisplayLabel('remote-agent:cursor'), 'Cursor Cloud Agent')
    assert.equal(
      remoteAgentDisplayLabel('remote-agent:cursor#composer-2', [
        { id: 'composer-2', label: 'Composer 2' },
      ]),
      'Cursor Cloud Agent — Composer 2',
    )
    assert.equal(
      remoteAgentDisplayLabel('remote-agent:anthropic#claude-sonnet-4-6'),
      'Claude Cloud Agent — claude-sonnet-4-6',
    )
  })
})
