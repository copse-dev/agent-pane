import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentChatModel } from './resolve-agent-model.ts'
import { clearProviderKeyStatusCache, recordProviderKeyValidation } from './provider-key-status.ts'
import { setSetting, deleteApiKey, setApiKey } from './settings.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'

describe('resolveAgentChatModel', () => {
  beforeEach(() => {
    clearProviderKeyStatusCache()
    deleteApiKey('cursor')
    deleteApiKey('anthropic')
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
    assert.equal(resolved.model, DEFAULT_APP_CHAT_MODEL)
    assert.match(resolved.fallbackNotice ?? '', /Could not run on \*\*Cursor Cloud Agent\*\*/)
    assert.match(resolved.fallbackNotice ?? '', /no valid API key/)
    assert.match(resolved.fallbackNotice ?? '', /qwen/)
  })

  it('keeps a remote agent when its key validated successfully', async () => {
    setApiKey('cursor', 'cur_valid')
    recordProviderKeyValidation('cursor', true)

    const resolved = await resolveAgentChatModel('remote-agent:cursor')
    assert.equal(resolved.model, 'remote-agent:cursor')
    assert.equal(resolved.fallbackNotice, undefined)
  })
})
