import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLocalModelCatalog,
  preflightLocalModels,
  probeLocalModel,
  requiredContextTokens,
  serverOrigin,
  type ProbeFetch,
} from './local-model-probe.ts'
import type { LocalEndpoint } from './provider-selection.ts'

const endpoint: LocalEndpoint = {
  kind: 'lmstudio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
}

/** LM Studio's native v1 catalogue, as 0.4 builds answer `/api/v1/models`. */
function v1Catalog(contextLength: number | null): string {
  return JSON.stringify({
    models: [
      {
        type: 'llm',
        key: 'qwen/qwen3-coder-30b',
        format: 'mlx',
        architecture: 'qwen3_moe',
        quantization: { name: '4bit', bits_per_weight: 4 },
        max_context_length: 262_144,
        capabilities: { vision: false, trained_for_tool_use: true },
        loaded_instances:
          contextLength === null
            ? []
            : [{ id: 'qwen/qwen3-coder-30b', config: { context_length: contextLength } }],
      },
      { type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5' },
      { type: 'vlm', key: 'qwen/qwen3-vl-32b', loaded_instances: [] },
    ],
  })
}

function serving(routes: Record<string, string>): { fetch: ProbeFetch; urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetch: (url: string, init: RequestInit): Promise<Response> => {
      urls.push(url)
      assert.equal(init.redirect, 'manual')
      const path = new URL(url).pathname
      const body = Object.hasOwn(routes, path) ? routes[path] : undefined
      return Promise.resolve(
        body === undefined ? new Response('', { status: 404 }) : new Response(body),
      )
    },
  }
}

describe('local model probe', () => {
  it("reads a loaded model's context, vision and quantisation from LM Studio's catalogue", () => {
    const probe = parseLocalModelCatalog('qwen/qwen3-coder-30b', v1Catalog(65_536))
    assert.deepEqual(probe, {
      status: 'found',
      info: {
        server: 'lmstudio',
        model: 'qwen/qwen3-coder-30b',
        loaded: true,
        loadedContextLength: 65_536,
        maxContextLength: 262_144,
        vision: false,
        quantization: '4bit',
        format: 'mlx',
        architecture: 'qwen3_moe',
      },
    })
    const vlm = parseLocalModelCatalog('qwen/qwen3-vl-32b', v1Catalog(null))
    assert.equal(vlm?.status === 'found' && vlm.info.vision, true)
  })

  it('reads the older v0 catalogue shape too', () => {
    const probe = parseLocalModelCatalog(
      'gemma-3-27b',
      JSON.stringify({
        data: [
          {
            id: 'gemma-3-27b',
            type: 'vlm',
            arch: 'gemma3',
            quantization: 'Q4_K_M',
            compatibility_type: 'gguf',
            state: 'loaded',
            max_context_length: 131_072,
            loaded_context_length: 4_096,
          },
        ],
      }),
    )
    assert.ok(probe?.status === 'found')
    assert.equal(probe.info.loaded, true)
    assert.equal(probe.info.loadedContextLength, 4_096)
    assert.equal(probe.info.quantization, 'Q4_K_M')
    assert.equal(probe.info.format, 'gguf')
    assert.equal(probe.info.vision, true)
  })

  it('names the chat models it has when the requested one is missing, and skips odd rows', () => {
    const text = JSON.stringify({
      models: [
        { key: 'a-model', type: 'llm' },
        { key: 42 },
        'not a row',
        { key: 'embed', type: 'embedding' },
      ],
    })
    assert.deepEqual(parseLocalModelCatalog('other', text), {
      status: 'missing',
      available: ['a-model'],
    })
    assert.equal(parseLocalModelCatalog('x', 'not json'), null)
    assert.equal(parseLocalModelCatalog('x', '{"object":"list"}'), null)
  })

  it('falls back to the v0 path and says why when neither answers', async () => {
    const v0 = serving({
      '/api/v0/models': JSON.stringify({ data: [{ id: 'm', state: 'not-loaded' }] }),
    })
    const probe = await probeLocalModel(endpoint, 'm', { fetch: v0.fetch })
    assert.equal(probe.status, 'found')
    assert.deepEqual(v0.urls, [
      'http://127.0.0.1:1234/api/v1/models',
      'http://127.0.0.1:1234/api/v0/models',
    ])
    const none = await probeLocalModel(endpoint, 'm', { fetch: serving({}).fetch })
    assert.ok(none.status === 'unknown')
    assert.match(none.reason, /HTTP 404.*HTTP 404/)
    const refused = await probeLocalModel(endpoint, 'm', {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    })
    assert.ok(refused.status === 'unknown')
    assert.match(refused.reason, /ECONNREFUSED/)
  })

  it('strips the OpenAI path from the base URL', () => {
    assert.equal(serverOrigin('http://localhost:1234/v1/'), 'http://localhost:1234')
    assert.equal(serverOrigin('http://host:8080'), 'http://host:8080')
  })
})

describe('local model pre-flight', () => {
  const route = { model: 'qwen/qwen3-coder-30b', endpoint }
  const needed = requiredContextTokens(60_000)

  it('refuses a model loaded with too little context, with the command that fixes it', async () => {
    const { fetch } = serving({ '/api/v1/models': v1Catalog(4_096) })
    const result = await preflightLocalModels([route, route], { minContextTokens: needed, fetch })
    assert.equal(result.problems.length, 1)
    assert.match(result.problems[0] ?? '', /loaded with a 4096-token context/)
    assert.match(
      result.problems[0] ?? '',
      new RegExp(`lms load qwen/qwen3-coder-30b --context-length ${String(needed)}`),
    )
    assert.equal(result.models.get(route.model)?.vision, false)
  })

  it('accepts enough context, notes a model that is not loaded, and can skip the check', async () => {
    const roomy = await preflightLocalModels([route], {
      minContextTokens: needed,
      fetch: serving({ '/api/v1/models': v1Catalog(65_536) }).fetch,
    })
    assert.deepEqual(roomy.problems, [])
    assert.deepEqual(roomy.notes, [])
    const unloaded = await preflightLocalModels([route], {
      minContextTokens: needed,
      fetch: serving({ '/api/v1/models': v1Catalog(null) }).fetch,
    })
    assert.deepEqual(unloaded.problems, [])
    assert.match(unloaded.notes[0] ?? '', /not loaded/)
    const skipped = await preflightLocalModels([route], {
      minContextTokens: 0,
      fetch: serving({ '/api/v1/models': v1Catalog(4_096) }).fetch,
    })
    assert.deepEqual(skipped.problems, [])
  })

  it('refuses a model the server does not have and notes a server it cannot read', async () => {
    const missing = await preflightLocalModels([{ model: 'nope', endpoint }], {
      minContextTokens: needed,
      fetch: serving({ '/api/v1/models': v1Catalog(65_536) }).fetch,
    })
    assert.match(missing.problems[0] ?? '', /has no model nope \(available: qwen\/qwen3-coder-30b/)
    const unreadable = await preflightLocalModels([route], {
      minContextTokens: needed,
      fetch: serving({}).fetch,
    })
    assert.deepEqual(unreadable.problems, [])
    assert.match(unreadable.notes[0] ?? '', /context length was not checked/)
  })

  it('refuses a context the model cannot reach at all', async () => {
    const result = await preflightLocalModels([route], {
      minContextTokens: 300_000,
      fetch: serving({ '/api/v1/models': v1Catalog(65_536) }).fetch,
    })
    assert.match(result.problems[0] ?? '', /supports at most 262144 tokens/)
  })
})
