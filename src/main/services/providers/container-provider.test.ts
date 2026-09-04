import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { deleteApiKey, setApiKey, setSetting } from '../storage/settings.test-shim.ts'
import { resolveContainerProvider } from './container-provider.ts'

describe('resolveContainerProvider', () => {
  beforeEach(async () => {
    for (const slug of ['anthropic', 'openai', 'openrouter', 'lmstudio']) deleteApiKey(slug)
    await setSetting('localServerUrl', '')
  })

  it('routes a local model to the configured local server, with its origin as egress', async () => {
    await setSetting('localServerUrl', 'http://localhost:1234/v1')
    const plan = resolveContainerProvider('lmstudio:qwen3')
    assert.equal(plan.mode, 'openai-compatible')
    assert.equal(plan.url, 'http://localhost:1234/v1')
    assert.equal(plan.model, 'qwen3')
    assert.equal(plan.egress, 'localhost:1234')
  })

  it('routes claude models through the product resolver with the anthropic key', () => {
    setApiKey('anthropic', 'sk-ant-test')
    const plan = resolveContainerProvider('claude-sonnet-4-6')
    assert.equal(plan.mode, 'product')
    assert.equal(plan.apiKeySlug, 'anthropic')
    assert.equal(plan.apiKey, 'sk-ant-test')
    assert.equal(plan.egress, 'api.anthropic.com:443')
  })

  it('routes gpt models to the OpenAI endpoint', () => {
    setApiKey('openai', 'sk-test')
    const plan = resolveContainerProvider('gpt-5')
    assert.equal(plan.mode, 'openai-compatible')
    assert.equal(plan.egress, 'api.openai.com:443')
    assert.equal(plan.apiKey, 'sk-test')
  })

  it('refuses a cloud model with no key rather than starting a run that cannot talk', () => {
    assert.throws(() => resolveContainerProvider('claude-sonnet-4-6'), /not configured/)
    assert.throws(() => resolveContainerProvider('gpt-5'), /not configured/)
  })

  it('refuses a model it cannot place', () => {
    assert.throws(() => resolveContainerProvider('mystery-model'), /cannot resolve a provider/)
  })
})
