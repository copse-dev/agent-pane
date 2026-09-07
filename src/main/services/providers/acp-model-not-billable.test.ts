import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildProvider } from './provider-selection.ts'
import { setSetting, setApiKey } from '../storage/settings.test-shim.ts'

// Regression: a device-agent model id must never be built into a directly-billed
// provider. `acp:<agent>#<model>` matches none of buildProvider's branches, so it
// used to reach the final API-key fallback in createProvider — which, seeing
// neither a `gpt` nor a `claude` prefix, constructed an AnthropicProvider around
// the literal `acp:...` string and charged the user's own Anthropic account.
// Chat turns route to the agent before reaching here, but comparison reviewers,
// subagents, small tasks, image description and orchestration workers do not.

const CLAUDE_ACP = {
  id: 'claude-agent-acp',
  title: 'Claude',
  command: 'claude-agent-acp',
  enabled: true,
}

describe('device-agent models are never built into a billed provider', () => {
  beforeEach(async () => {
    await setSetting('registeredAcpAgents', [CLAUDE_ACP])
    // The bug only bites when a key is present: without one the fallback throws
    // for its own reasons, so seed one to prove the guard is what stops it.
    setApiKey('anthropic', 'sk-ant-api03-test')
  })

  it('refuses an agent id with a model, rather than billing Anthropic', async () => {
    await assert.rejects(
      () => buildProvider('acp:claude-agent-acp#opus'),
      (err: Error) => {
        assert.match(err.message, /Claude/)
        assert.match(err.message, /cannot be used for this/)
        // The wire protocol name stays out of user-facing copy.
        assert.doesNotMatch(err.message, /\bACP\b/)
        return true
      },
    )
  })

  it('refuses a bare agent id too', async () => {
    await assert.rejects(() => buildProvider('acp:claude-agent-acp'), /cannot be used for this/)
  })

  it('names an agent that is no longer registered instead of failing blank', async () => {
    await setSetting('registeredAcpAgents', [])
    await assert.rejects(() => buildProvider('acp:some-agent#x'), /some-agent/)
  })

  it('still builds a normal cloud model', async () => {
    const provider = await buildProvider('claude-opus-4-1')
    assert.ok(provider, 'a directly-served model must be unaffected by the guard')
  })
})
