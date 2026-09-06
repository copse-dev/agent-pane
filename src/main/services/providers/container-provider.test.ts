import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { deleteApiKey, setApiKey, setSetting } from '../storage/settings.test-shim.ts'
import { explainContainerModel, resolveContainerProvider } from './container-provider.ts'

const CLAUDE_AGENT: AcpAgentConfig = {
  id: 'claude-acp',
  title: 'Claude',
  command: '/Users/me/.local/bin/claude-agent-acp',
  env: { ANTHROPIC_API_KEY: 'sk-ant-desktop' },
  enabled: true,
}
const CURSOR_AGENT: AcpAgentConfig = {
  id: 'cursor',
  title: 'Cursor',
  command: 'cursor-agent',
  args: ['acp'],
  enabled: true,
}
const CUSTOM_AGENT: AcpAgentConfig = {
  id: 'my-own-agent',
  title: 'Mine',
  command: 'my-agent',
  enabled: true,
}

describe('resolveContainerProvider', () => {
  beforeEach(async () => {
    for (const slug of ['anthropic', 'openai', 'openrouter', 'lmstudio', 'gemini']) {
      deleteApiKey(slug)
    }
    await setSetting('localServerUrl', '')
    await setSetting('registeredAcpAgents', [])
  })

  it('routes a local model to the configured local server, with its origin as egress', async () => {
    await setSetting('localServerUrl', 'http://localhost:1234/v1')
    const plan = resolveContainerProvider('lmstudio:qwen3')
    assert.equal(plan.mode, 'openai-compatible')
    assert.equal(plan.url, 'http://localhost:1234/v1')
    assert.equal(plan.model, 'qwen3')
    assert.deepEqual(plan.egress, ['localhost:1234'])
  })

  it('routes claude models through the product resolver with the anthropic key', () => {
    setApiKey('anthropic', 'sk-ant-test')
    const plan = resolveContainerProvider('claude-sonnet-4-6')
    assert.equal(plan.mode, 'product')
    assert.equal(plan.apiKeySlug, 'anthropic')
    assert.equal(plan.apiKey, 'sk-ant-test')
    assert.deepEqual(plan.egress, ['api.anthropic.com:443'])
  })

  it('routes gpt models to the OpenAI endpoint', () => {
    setApiKey('openai', 'sk-test')
    const plan = resolveContainerProvider('gpt-5')
    assert.equal(plan.mode, 'openai-compatible')
    assert.deepEqual(plan.egress, ['api.openai.com:443'])
    assert.equal(plan.apiKey, 'sk-test')
  })

  it('refuses a cloud model with no key rather than starting a run that cannot talk', () => {
    assert.throws(() => resolveContainerProvider('claude-sonnet-4-6'), /not configured/)
    assert.throws(() => resolveContainerProvider('gpt-5'), /not configured/)
  })

  it('refuses a model it cannot place', () => {
    assert.throws(() => resolveContainerProvider('mystery-model'), /cannot resolve a provider/)
  })

  it('says why a remote or plugin agent cannot run in a container', () => {
    // The picker offers these (greyed out), so the refusal has to explain
    // itself rather than read as an internal resolver miss: an agent signs in
    // as the user, and the guest is given no credentials by design.
    for (const model of ['remote-agent:anthropic#x', 'plugin-model:foo']) {
      assert.throws(() => resolveContainerProvider(model), /signed in as you|credentials/)
    }
  })

  describe('ACP agents', () => {
    it('runs a key-capable agent under its vendor key, on its catalogue domains', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      setApiKey('anthropic', 'sk-ant-run')
      const plan = resolveContainerProvider('acp:claude-acp#claude-opus-5')
      assert.equal(plan.mode, 'acp')
      // The full selection travels: the guest routes `acp:` as the desktop does.
      assert.equal(plan.model, 'acp:claude-acp#claude-opus-5')
      assert.equal(plan.apiKey, 'sk-ant-run')
      assert.equal(plan.harness.keyEnvName, 'ANTHROPIC_API_KEY')
      // Catalogue command, not the desktop's absolute path; no user env at all.
      assert.equal(plan.harness.agent.command, 'claude-agent-acp')
      assert.equal(plan.harness.agent.env, undefined)
      assert.equal(plan.harness.agent.sandbox, false)
      assert.ok(plan.egress.includes('*.anthropic.com:443'))
      assert.ok(plan.egress.includes('claude.ai:443'))
      assert.ok(!JSON.stringify(plan.harness).includes('sk-ant'))
    })

    it('refuses a key-capable agent without its key, naming the key', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      assert.throws(
        () => resolveContainerProvider('acp:claude-acp'),
        /needs an Anthropic API key in Settings/,
      )
    })

    it('accepts a key from the environment, as the run would', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      const previous = process.env['ANTHROPIC_API_KEY']
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-env'
      try {
        assert.equal(explainContainerModel('acp:claude-acp'), null)
        const plan = resolveContainerProvider('acp:claude-acp')
        assert.equal(plan.mode, 'acp')
        assert.equal(plan.apiKey, 'sk-ant-from-env')
      } finally {
        if (previous === undefined) delete process.env['ANTHROPIC_API_KEY']
        else process.env['ANTHROPIC_API_KEY'] = previous
      }
    })

    it('explains a row with the short per-agent reason the dialog shows', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT, CURSOR_AGENT, CUSTOM_AGENT])
      assert.equal(
        explainContainerModel('acp:claude-acp#claude-opus-5'),
        'needs an Anthropic API key in Settings',
      )
      assert.equal(
        explainContainerModel('acp:cursor'),
        'signs in through a browser; no API-key path',
      )
      assert.equal(explainContainerModel('acp:my-own-agent'), 'not carried by the worker image')
      assert.equal(explainContainerModel('acp:never-registered'), 'not configured in Settings')
      assert.equal(
        explainContainerModel('remote-agent:anthropic#x'),
        'not available in a container',
      )
      setApiKey('anthropic', 'sk-ant-run')
      assert.equal(explainContainerModel('acp:claude-acp#claude-opus-5'), null)
    })

    it('refuses an agent that only signs in through a browser, whatever keys exist', async () => {
      await setSetting('registeredAcpAgents', [CURSOR_AGENT])
      setApiKey('anthropic', 'sk-ant-run')
      assert.throws(() => resolveContainerProvider('acp:cursor'), /signs in through a browser/)
    })

    it('refuses an agent the image does not carry', async () => {
      await setSetting('registeredAcpAgents', [CUSTOM_AGENT])
      assert.throws(
        () => resolveContainerProvider('acp:my-own-agent'),
        /not carried by the worker image/,
      )
    })

    it('refuses an agent that is not registered or is disabled', async () => {
      assert.throws(() => resolveContainerProvider('acp:claude-acp'), /not configured/)
      await setSetting('registeredAcpAgents', [{ ...CLAUDE_AGENT, enabled: false }])
      assert.throws(() => resolveContainerProvider('acp:claude-acp'), /not configured/)
    })
  })
})
