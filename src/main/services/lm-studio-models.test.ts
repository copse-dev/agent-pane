import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  lmStudioOrigin,
  parseContextFromModelRecord,
  effectiveContextFromNativeModelRecord,
} from './lm-studio-models.ts'

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
