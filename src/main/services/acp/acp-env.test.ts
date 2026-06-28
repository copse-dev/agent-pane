import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAcpAgentEnv } from './acp-client.ts'

/**
 * The spawned external ACP agent runs its own model loop, so it must not inherit
 * Copse's cloud LLM/provider API keys. `buildAcpAgentEnv` scrubs those secrets
 * from the base env while letting the caller's explicit `config.env` allowlist
 * (and legitimate non-LLM tool tokens like GITHUB_TOKEN) through.
 */
describe('buildAcpAgentEnv', () => {
  const injected = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN']

  afterEach(() => {
    for (const key of injected) delete process.env[key]
  })

  it('strips LLM API keys from the spawned env but keeps non-LLM tool tokens', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret'
    process.env.OPENAI_API_KEY = 'sk-openai-secret'
    process.env.OPENROUTER_API_KEY = 'sk-or-secret'
    process.env.GITHUB_TOKEN = 'gh-token'

    const env = buildAcpAgentEnv({ command: 'agent', cwd: '/tmp/project' })

    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.OPENROUTER_API_KEY, undefined)
    assert.equal(env.GITHUB_TOKEN, 'gh-token')
  })

  it('overlays config.env on top of the scrubbed base', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret'

    const env = buildAcpAgentEnv({
      command: 'agent',
      cwd: '/tmp/project',
      env: { GEMINI_API_KEY: 'explicitly-allowed', AGENT_FLAG: '1' },
    })

    // A secret the agent is explicitly meant to receive is honored when passed
    // through config.env, even though it would otherwise be scrubbed.
    assert.equal(env.GEMINI_API_KEY, 'explicitly-allowed')
    assert.equal(env.AGENT_FLAG, '1')
    // But the ambient process.env secret is still not leaked.
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
  })
})
