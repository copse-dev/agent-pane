import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentChatModel } from './resolve-agent-model.ts'
import { clearProviderKeyStatusCache, recordProviderKeyValidation } from './provider-key-status.ts'
import { setSetting, deleteApiKey, setApiKey } from '../storage/settings.ts'
import { FALLBACK_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'

describe('resolveAgentChatModel', () => {
  beforeEach(async () => {
    clearProviderKeyStatusCache()
    deleteApiKey('cursor')
    deleteApiKey('anthropic')
    await setSetting('registeredAcpAgents', [])
    await setSetting('preferAcpOverCloudAgent', true)
  })

  it('passes through a runnable non-remote model unchanged', async () => {
    const resolved = await resolveAgentChatModel('lmstudio:local-x')
    assert.equal(resolved.model, 'lmstudio:local-x')
    assert.equal(resolved.fallbackNotice, undefined)
  })

  it('falls back to the default local chat model when a remote agent has no valid key', async () => {
    await setSetting('model', 'remote-agent:cursor')
    setApiKey('cursor', 'cur_invalid')
    recordProviderKeyValidation('cursor', false)

    const resolved = await resolveAgentChatModel('remote-agent:cursor')
    assert.equal(resolved.model, FALLBACK_APP_CHAT_MODEL)
    assert.match(resolved.fallbackNotice ?? '', /Could not run on \*\*Cursor Cloud Agent\*\*/)
    assert.match(resolved.fallbackNotice ?? '', /no valid API key/)
    assert.match(resolved.fallbackNotice ?? '', /qwen/)
    assert.deepEqual(resolved.blockedRemoteAgent, { provider: 'cursor' })
  })

  it('reports the blocked selection so the turn can offer an alternative', async () => {
    setApiKey('anthropic', 'sk-ant-api03-invalid')
    recordProviderKeyValidation('anthropic', false)

    const resolved = await resolveAgentChatModel('remote-agent:anthropic#claude-opus-4-8')
    assert.deepEqual(resolved.blockedRemoteAgent, {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    })
  })

  it('expands the best-value sentinel to a concrete routable model', async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    try {
      const resolved = await resolveAgentChatModel('auto:best-value')
      assert.equal(resolved.model, FALLBACK_APP_CHAT_MODEL)
      assert.equal(resolved.fallbackNotice, undefined)
    } finally {
      delete process.env['COPSE_PANEL_MOCK_LLM']
    }
  })

  it('keeps a remote agent when its key validated successfully', async () => {
    setApiKey('cursor', 'cur_valid')
    recordProviderKeyValidation('cursor', true)

    const resolved = await resolveAgentChatModel('remote-agent:cursor')
    assert.equal(resolved.model, 'remote-agent:cursor')
    assert.equal(resolved.fallbackNotice, undefined)
    assert.equal(resolved.blockedRemoteAgent, undefined)
  })

  // A working Claude Cloud Agent selection is honoured even with an ACP Claude
  // agent registered: the managed Agents API is API-key-billed by design and has
  // no subscription mode, and swapping a remote sandbox run for a local one
  // changes what the turn does — so the switch is offered on failure, never
  // applied pre-emptively.
  it('keeps Claude Cloud Agent when its key is valid, even with an ACP Claude agent enabled', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'claude-agent-acp', title: 'Claude', command: 'claude-agent-acp', enabled: true },
    ])
    setApiKey('anthropic', 'sk-ant-api03-valid')
    recordProviderKeyValidation('anthropic', true)

    const resolved = await resolveAgentChatModel('remote-agent:anthropic')
    assert.equal(resolved.model, 'remote-agent:anthropic')
    assert.equal(resolved.fallbackNotice, undefined)
    assert.equal(resolved.blockedRemoteAgent, undefined)
  })

  it('preserves the pinned model on a runnable Claude Cloud Agent selection', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'claude-code-acp', title: 'Claude Code', command: 'claude-code-acp', enabled: true },
    ])
    setApiKey('anthropic', 'sk-ant-api03-valid')
    recordProviderKeyValidation('anthropic', true)

    const resolved = await resolveAgentChatModel('remote-agent:anthropic#claude-opus-4-8')
    assert.equal(resolved.model, 'remote-agent:anthropic#claude-opus-4-8')
  })
})
