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

  it('redacts for an LM Studio endpoint on another host and ignores blank settings', () => {
    const remoteStudio = selectProvider(
      { kind: 'lmstudio', model: 'qwen' },
      { LM_STUDIO_URL: 'https://gpu.example:1234/v1' },
    )
    assert.equal(remoteStudio.remote, true)
    const blankUrl = selectProvider({ model: 'qwen3-coder' }, { LM_STUDIO_URL: '' })
    assert.equal(blankUrl.kind, 'lmstudio')
    assert.equal(blankUrl.remote, false, 'a blank URL falls back to the local default')
    assert.throws(
      () => selectProvider({ kind: 'lmstudio' }, { LM_STUDIO_MODEL: ' ' }),
      /--model \(or LM_STUDIO_MODEL\)/,
    )
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

  it('accepts base OpenRouter hosts or automatic routing, rejecting paid tier slugs', () => {
    for (const preference of ['', 'auto', 'openai', 'azure']) {
      assert.equal(
        selectProvider(
          { kind: 'openrouter', model: 'openai/gpt-6-luna' },
          { OPENROUTER_API_KEY: 'fixture-key', COPSE_REVIEW_OPENROUTER_PROVIDER: preference },
        ).remote,
        true,
      )
    }
    for (const preference of ['openai/fast', 'openai/flex', 'openai,azure', 'OpenAI']) {
      assert.throws(
        () =>
          selectProvider(
            { kind: 'openrouter', model: 'openai/gpt-6-luna' },
            { OPENROUTER_API_KEY: 'fixture-key', COPSE_REVIEW_OPENROUTER_PROVIDER: preference },
          ),
        /must be a base provider slug or auto/,
      )
    }
    assert.equal(
      selectProvider({ kind: 'mock' }, { COPSE_REVIEW_OPENROUTER_PROVIDER: 'ignored/value' }).kind,
      'mock',
    )
  })

  it('carries Luna’s output budget and private host routing to every review role', async (t) => {
    const requests: unknown[] = []
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
      assert.equal(typeof init?.body, 'string')
      if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
      const body: unknown = JSON.parse(init.body)
      requests.push(body)
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const selected = selectProvider(
      { model: 'openai/gpt-6-luna' },
      { OPENROUTER_API_KEY: 'fixture-key', COPSE_REVIEW_OPENROUTER_PROVIDER: 'openai' },
    )
    for (const role of ['review:correctness', 'reproduce', 'challenge']) {
      for await (const _ of selected
        .providerFor(role)
        .stream([{ role: 'user', content: 'hi' }], [])) {
        // Drain the actual adapter request through the redacting wrapper.
      }
    }
    assert.equal(requests.length, 3)
    for (const request of requests) {
      assert.ok(request !== null && typeof request === 'object')
      assert.equal(Reflect.get(request, 'max_tokens'), 8_192)
      assert.equal(Reflect.get(request, 'reasoning'), undefined)
      assert.deepEqual(Reflect.get(request, 'provider'), {
        require_parameters: true,
        order: ['openai'],
        allow_fallbacks: true,
        zdr: true,
        data_collection: 'deny',
      })
    }
    // The review-specific Luna budget must not change other models' settings.
    const other = selectProvider(
      { kind: 'openrouter', model: 'fixture/other-model' },
      { OPENROUTER_API_KEY: 'fixture-key' },
    )
    for await (const _ of other.provider.stream([{ role: 'user', content: 'hi' }], [])) {
      // Capture the same real transport for a model with no preset ceiling.
    }
    const otherRequest = requests[3]
    assert.ok(otherRequest !== null && typeof otherRequest === 'object')
    assert.equal(Reflect.get(otherRequest, 'max_tokens'), undefined)
  })
})
