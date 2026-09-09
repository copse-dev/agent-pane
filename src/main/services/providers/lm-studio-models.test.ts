import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  lmStudioOrigin,
  parseContextFromModelRecord,
  effectiveContextFromNativeModelRecord,
  fetchLmStudioModels,
  looksLikeEmbeddingModelId,
} from './lm-studio-models.ts'
import { jsonResponse } from './test-response.ts'

describe('lmStudioOrigin', () => {
  it('strips trailing /v1 from OpenAI base URL', () => {
    assert.equal(lmStudioOrigin('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234')
    assert.equal(lmStudioOrigin('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234')
  })
})

describe('parseContextFromModelRecord', () => {
  it('reads common top-level fields', () => {
    assert.equal(parseContextFromModelRecord({ max_context_length: 32768 }), 32768)
    assert.equal(parseContextFromModelRecord({ n_ctx: '8192' }), 8192)
  })

  it('reads nested load_config', () => {
    assert.equal(
      parseContextFromModelRecord({ id: 'x', load_config: { context_length: 16384 } }),
      16384,
    )
  })

  it('prefers loaded instance context over catalog max (native API)', () => {
    assert.equal(
      effectiveContextFromNativeModelRecord({
        key: 'qwen/qwen3.6-35b-a3b',
        max_context_length: 262144,
        loaded_instances: [{ id: 'qwen/qwen3.6-35b-a3b', config: { context_length: 15050 } }],
      }),
      15050,
    )
  })
})

describe('LM Studio model capabilities', () => {
  it('reads native vision metadata and merges it into the OpenAI model list', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mock.fn<typeof fetch>(async (url) =>
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
        '/api/v1/models',
      )
        ? jsonResponse({
            models: [
              { key: 'qwen-vl', capabilities: { vision: true } },
              { key: 'qwen-text', capabilities: { vision: false } },
            ],
          })
        : jsonResponse({ data: [{ id: 'qwen-vl' }, { id: 'qwen-text' }] }),
    )
    globalThis.fetch = fetchMock
    try {
      const result = await fetchLmStudioModels('http://127.0.0.1:1234/v1')
      assert.equal(result.ok, true)
      assert.deepEqual(result.models, [
        { id: 'qwen-vl', contextLength: null, supportsImages: true },
        { id: 'qwen-text', contextLength: null, supportsImages: false },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// #2487. `text-embedding-nomic-embed-text-v1.5` was offered in the chat and
// comparison-reviewer pickers alongside models that can hold a conversation. It
// has no chat completion, so choosing it produces a run that cannot start.
describe('embedding models are identified', () => {
  it('reads the type LM Studio declares, rather than guessing from the name', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mock.fn<typeof fetch>(async (url) =>
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
        '/api/v1/models',
      )
        ? jsonResponse({
            models: [
              { key: 'nomic-embed-text-v1.5', type: 'embeddings' },
              { key: 'qwen3-coder-30b', type: 'llm' },
            ],
          })
        : jsonResponse({ data: [{ id: 'nomic-embed-text-v1.5' }, { id: 'qwen3-coder-30b' }] }),
    )
    globalThis.fetch = fetchMock
    try {
      const result = await fetchLmStudioModels('http://127.0.0.1:1234/v1')
      assert.deepEqual(result.models, [
        { id: 'nomic-embed-text-v1.5', contextLength: null, embedding: true },
        { id: 'qwen3-coder-30b', contextLength: null },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to the id when only the OpenAI-compatible endpoint answers', async () => {
    // That endpoint declares no type, so the name is the only signal left.
    const originalFetch = globalThis.fetch
    const fetchMock = mock.fn<typeof fetch>(async (url) =>
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
        '/api/v1/models',
      )
        ? jsonResponse({}, 404)
        : jsonResponse({
            data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen3-coder-30b' }],
          }),
    )
    globalThis.fetch = fetchMock
    try {
      const result = await fetchLmStudioModels('http://127.0.0.1:1234/v1')
      assert.deepEqual(result.models, [
        { id: 'text-embedding-nomic-embed-text-v1.5', contextLength: null, embedding: true },
        { id: 'qwen3-coder-30b', contextLength: null },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('lets a declared type overrule the name', async () => {
    // A model whose id reads like an embedding but which the server says is an
    // LLM stays in the picker. The declaration is evidence; the name is a guess.
    const originalFetch = globalThis.fetch
    const fetchMock = mock.fn<typeof fetch>(async (url) =>
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
        '/api/v1/models',
      )
        ? jsonResponse({ models: [{ key: 'text-embedding-oddly-named-chat', type: 'llm' }] })
        : jsonResponse({ data: [{ id: 'text-embedding-oddly-named-chat' }] }),
    )
    globalThis.fetch = fetchMock
    try {
      const result = await fetchLmStudioModels('http://127.0.0.1:1234/v1')
      assert.deepEqual(result.models, [
        { id: 'text-embedding-oddly-named-chat', contextLength: null },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('looksLikeEmbeddingModelId', () => {
  it('recognises the ids that announce themselves', () => {
    for (const id of [
      'text-embedding-nomic-embed-text-v1.5',
      'text-embedding-3-large',
      'nomic-ai/nomic-embed-text-v1.5',
      'qwen3-embedding-8b',
      'bge-m3-embedding',
      'EmbeddingGemma/embedding',
    ]) {
      assert.equal(looksLikeEmbeddingModelId(id), true, id)
    }
  })

  it('leaves a chat model alone, including ones that merely contain the letters', () => {
    // A wrong `true` hides a usable model from the picker with nothing on screen
    // to say why, so the pattern only matches a standalone token.
    for (const id of [
      'qwen3-coder-30b',
      'llama-3.3-70b-instruct',
      'mistral-small-latest',
      'gpt-oss-120b',
      'embedded-systems-assistant',
      'my-embedder-chat',
      'deepseek-r1-distill-qwen-32b',
    ]) {
      assert.equal(looksLikeEmbeddingModelId(id), false, id)
    }
  })
})
