import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_KINDS,
  inferProviderKind,
  isProviderKind,
  selectProvider,
} from './provider-selection.ts'
import { ScriptedProvider } from './scripted-provider.ts'

describe('provider selection', () => {
  it('infers the door from the model id', () => {
    assert.equal(inferProviderKind('claude-sonnet-5'), 'anthropic')
    assert.equal(inferProviderKind('gpt-5'), 'openai')
    assert.equal(inferProviderKind('anthropic/claude-sonnet-5'), 'openrouter')
    assert.equal(inferProviderKind('qwen3-coder'), 'lmstudio')
    assert.equal(inferProviderKind(undefined), 'lmstudio')
    for (const kind of PROVIDER_KINDS) assert.equal(isProviderKind(kind), true)
    assert.equal(isProviderKind('bard'), false)
  })

  it('reads keys from the environment only and fails closed without them', () => {
    assert.throws(() => selectProvider({ kind: 'anthropic' }, {}), /ANTHROPIC_API_KEY is not set/)
    assert.throws(() => selectProvider({ kind: 'openai' }, {}), /OPENAI_API_KEY is not set/)
    assert.throws(
      () => selectProvider({ kind: 'openrouter', model: 'a/b' }, {}),
      /OPENROUTER_API_KEY/,
    )
    assert.throws(() => selectProvider({ kind: 'lmstudio' }, {}), /--model/)
    assert.throws(() => selectProvider({ kind: 'openai-compatible' }, {}), /--model/)
  })

  it('wraps remote providers in redaction and leaves local ones alone', () => {
    const remote = selectProvider(
      { kind: 'anthropic', model: 'claude-sonnet-5' },
      { ANTHROPIC_API_KEY: 'sk-ant-test-key-value' },
    )
    assert.equal(remote.remote, true)
    assert.equal(remote.model, 'claude-sonnet-5')
    const local = selectProvider(
      { kind: 'lmstudio', model: 'qwen' },
      { LM_STUDIO_URL: 'http://localhost:1234/v1' },
    )
    assert.equal(local.remote, false)
    const compatibleLocal = selectProvider(
      { kind: 'openai-compatible', model: 'm', baseUrl: 'http://127.0.0.1:8080/v1' },
      {},
    )
    assert.equal(compatibleLocal.remote, false)
    const compatibleRemote = selectProvider(
      { kind: 'openai-compatible', model: 'm', baseUrl: 'https://api.example.com/v1' },
      {},
    )
    assert.equal(compatibleRemote.remote, true)
  })

  it('accepts the CI model key for each hosted provider', () => {
    const env = { COPSE_REVIEW_API_KEY: 'offline-ci-key' }
    for (const model of ['claude-sonnet-5', 'gpt-5', 'anthropic/claude-sonnet-5']) {
      assert.equal(selectProvider({ model }, env).model, model)
    }
    assert.throws(
      () => selectProvider({ model: 'claude-sonnet-5' }, { COPSE_REVIEW_API_KEY: '  ' }),
      /ANTHROPIC_API_KEY is not set/,
    )
  })

  it('builds the scripted provider for mock', () => {
    const selected = selectProvider({ kind: 'mock', script: [{ type: 'text', text: 'hi' }] }, {})
    assert.ok(selected.provider instanceof ScriptedProvider)
    assert.equal(selected.model, 'mock')
  })
})
