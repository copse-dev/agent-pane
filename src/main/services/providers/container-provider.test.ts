import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { deleteApiKey, setApiKey, setSetting } from '../storage/settings.test-shim.ts'
import {
  explainContainerModel,
  resolveContainerProvider,
  type ContainerProviderPlan,
} from './container-provider.ts'

const CLAUDE_AGENT: AcpAgentConfig = {
  id: 'claude-acp',
  title: 'Claude',
  command: '/Users/me/.local/bin/claude-agent-acp',
  env: { ANTHROPIC_API_KEY: 'sk-ant-desktop' },
  enabled: true,
}
const CODEX_AGENT: AcpAgentConfig = {
  id: 'codex-acp',
  title: 'Codex',
  command: 'codex-acp',
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
    await setSetting('localServerUrl', 'http://models.lan:1234/v1')
    const plan = await resolveContainerProvider('lmstudio:qwen3')
    assert.equal(plan.mode, 'provider')
    // LM Studio's own transport is a WebSocket the guest proxy cannot carry;
    // in the guest it is the OpenAI-compatible endpoint it also is.
    assert.equal(plan.provider.kind, 'openai-compatible')
    assert.equal(plan.provider.url, 'http://models.lan:1234/v1')
    assert.equal(plan.provider.model, 'qwen3')
    assert.deepEqual(plan.egress, ['models.lan:1234'])
    assert.equal(plan.egressResolve, undefined)
  })

  it("gives a server on the desktop's loopback a name the guest can reach it by", async () => {
    // The guest's loopback bypasses its proxy, so `127.0.0.1` in the guest is
    // the guest's own empty loopback; the alias goes through the broker, which
    // dials the host's.
    await setSetting('localServerUrl', 'http://127.0.0.1:1234/v1')
    const plan = await resolveContainerProvider('lmstudio:qwen3')
    assert.equal(plan.mode, 'provider')
    const url = (candidate: ContainerProviderPlan): string | null =>
      candidate.mode === 'provider' && candidate.provider.kind === 'openai-compatible'
        ? candidate.provider.url
        : null
    assert.equal(url(plan), 'http://model.copse.internal:1234/v1')
    assert.deepEqual(plan.egress, ['model.copse.internal:1234'])
    assert.deepEqual(plan.egressResolve, { 'model.copse.internal': '127.0.0.1' })
    await setSetting('localServerUrl', 'http://localhost:1234/v1')
    assert.equal(
      url(await resolveContainerProvider('lmstudio:qwen3')),
      'http://model.copse.internal:1234/v1',
    )
  })

  it('routes claude models to Anthropic with the anthropic key', async () => {
    setApiKey('anthropic', 'sk-ant-test')
    const plan = await resolveContainerProvider('claude-sonnet-4-6')
    assert.equal(plan.mode, 'provider')
    assert.equal(plan.provider.kind, 'anthropic')
    assert.equal(plan.provider.apiKeySlug, 'anthropic')
    assert.equal(plan.apiKey, 'sk-ant-test')
    assert.equal(plan.contextWindow, 1_000_000)
    assert.deepEqual(plan.egress, ['api.anthropic.com:443'])
  })

  it("routes gpt models to OpenAI with the desktop's transport choices", async () => {
    setApiKey('openai', 'sk-test')
    await setSetting('openAiServiceTier', 'flex')
    const plan = await resolveContainerProvider('gpt-5')
    assert.equal(plan.mode, 'provider')
    assert.equal(plan.provider.kind, 'openai')
    assert.equal(plan.provider.serviceTier, 'flex')
    assert.deepEqual(plan.egress, ['api.openai.com:443'])
    assert.equal(plan.apiKey, 'sk-test')
    await setSetting('openAiServiceTier', '')
  })

  it("carries the user's tuned parameters and OpenRouter's privacy routing", async () => {
    setApiKey('openrouter', 'sk-or-test')
    await setSetting('modelParameters', {
      'openrouter:qwen/qwen3': { temperature: 0.2, reasoning: 'high' },
    })
    await setSetting('openRouterZdrOnly', false)
    const plan = await resolveContainerProvider('openrouter:qwen/qwen3')
    assert.equal(plan.mode, 'provider')
    assert.equal(plan.provider.kind, 'openrouter')
    assert.equal(plan.provider.model, 'qwen/qwen3')
    assert.deepEqual(plan.provider.params, { temperature: 0.2, reasoning: 'high' })
    assert.equal(plan.provider.zdrOnly, false)
    assert.deepEqual(plan.egress, ['openrouter.ai:443'])
    await setSetting('modelParameters', {})
    await setSetting('openRouterZdrOnly', true)
  })

  it('refuses a cloud model with no key rather than starting a run that cannot talk', async () => {
    await assert.rejects(resolveContainerProvider('claude-sonnet-4-6'), /not configured/)
    await assert.rejects(resolveContainerProvider('gpt-5'), /not configured/)
  })

  it('refuses a model it cannot place', async () => {
    await assert.rejects(resolveContainerProvider('mystery-model'), /cannot resolve a provider/)
  })

  it('says why a remote or plugin agent cannot run in a container', async () => {
    // The picker offers these (greyed out), so the refusal has to explain
    // itself rather than read as an internal resolver miss: an agent signs in
    // as the user, and the guest is given no credentials by design.
    for (const model of ['remote-agent:anthropic#x', 'plugin-model:foo']) {
      await assert.rejects(resolveContainerProvider(model), /signed in as you|credentials/)
    }
  })

  describe('ACP agents', () => {
    it('runs a key-capable agent under its vendor key, on its catalogue domains', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      setApiKey('anthropic', 'sk-ant-run')
      const plan = await resolveContainerProvider('acp:claude-acp#claude-opus-5')
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
      await assert.rejects(
        resolveContainerProvider('acp:claude-acp'),
        /needs an Anthropic API key in Settings/,
      )
      // Claude has no sign-in to carry, so the opt-in changes nothing.
      await assert.rejects(
        resolveContainerProvider('acp:claude-acp', { useAgentLogin: true }),
        /needs an Anthropic API key in Settings/,
      )
      assert.deepEqual(await explainContainerModel('acp:claude-acp'), {
        reason: 'needs an Anthropic API key in Settings',
      })
    })

    it('runs Codex on the desktop sign-in only when opted in, and offers it otherwise', async () => {
      await setSetting('registeredAcpAgents', [CODEX_AGENT])
      // Not opted in: refused, but the dialog is told the row would run on
      // the sign-in, so it can show the opt-in for it.
      await assert.rejects(
        resolveContainerProvider('acp:codex-acp'),
        /needs an OpenAI API key in Settings, or your Codex sign-in/,
      )
      assert.deepEqual(await explainContainerModel('acp:codex-acp'), {
        reason: null,
        loginOffered: { agentTitle: 'Codex' },
      })
      // Opted in: a plan with no key and the sign-in directories to carry.
      const plan = await resolveContainerProvider('acp:codex-acp', { useAgentLogin: true })
      assert.equal(plan.mode, 'acp')
      assert.equal(plan.apiKey, null)
      assert.deepEqual(plan.harness.login, { files: ['.codex/auth.json'] })
      assert.ok(plan.egress.includes('*.openai.com:443'))
      // With a key, the key wins and nothing is carried in.
      setApiKey('openai', 'sk-openai-run')
      const keyed = await resolveContainerProvider('acp:codex-acp', { useAgentLogin: true })
      assert.equal(keyed.mode, 'acp')
      assert.equal(keyed.apiKey, 'sk-openai-run')
      assert.equal(keyed.harness.login, undefined)
      assert.deepEqual(await explainContainerModel('acp:codex-acp'), { reason: null })
    })

    it('accepts a key from the environment, as the run would', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      const previous = process.env['ANTHROPIC_API_KEY']
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-env'
      try {
        assert.deepEqual(await explainContainerModel('acp:claude-acp'), { reason: null })
        const plan = await resolveContainerProvider('acp:claude-acp')
        assert.equal(plan.mode, 'acp')
        assert.equal(plan.apiKey, 'sk-ant-from-env')
      } finally {
        if (previous === undefined) delete process.env['ANTHROPIC_API_KEY']
        else process.env['ANTHROPIC_API_KEY'] = previous
      }
    })

    it('explains a row with the short per-agent reason the dialog shows', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT, CURSOR_AGENT, CUSTOM_AGENT])
      assert.deepEqual(await explainContainerModel('acp:claude-acp#claude-opus-5'), {
        reason: 'needs an Anthropic API key in Settings',
      })
      assert.deepEqual(await explainContainerModel('acp:cursor'), {
        reason: 'signs in through a browser; no API-key path',
      })
      assert.deepEqual(await explainContainerModel('acp:my-own-agent'), {
        reason: 'not carried by the worker image',
      })
      assert.deepEqual(await explainContainerModel('acp:never-registered'), {
        reason: 'not configured in Settings',
      })
      assert.deepEqual(await explainContainerModel('remote-agent:anthropic#x'), {
        reason: 'not available in a container',
      })
      setApiKey('anthropic', 'sk-ant-run')
      assert.deepEqual(await explainContainerModel('acp:claude-acp#claude-opus-5'), {
        reason: null,
      })
    })

    it('refuses an agent that only signs in through a browser, whatever keys exist', async () => {
      await setSetting('registeredAcpAgents', [CURSOR_AGENT])
      setApiKey('anthropic', 'sk-ant-run')
      await assert.rejects(resolveContainerProvider('acp:cursor'), /signs in through a browser/)
    })

    it('refuses an agent the image does not carry', async () => {
      await setSetting('registeredAcpAgents', [CUSTOM_AGENT])
      await assert.rejects(
        resolveContainerProvider('acp:my-own-agent'),
        /not carried by the worker image/,
      )
    })

    it('refuses an agent that is not registered or is disabled', async () => {
      await assert.rejects(resolveContainerProvider('acp:claude-acp'), /not configured/)
      await setSetting('registeredAcpAgents', [{ ...CLAUDE_AGENT, enabled: false }])
      await assert.rejects(resolveContainerProvider('acp:claude-acp'), /not configured/)
    })
  })
})
