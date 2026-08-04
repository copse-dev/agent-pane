import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOUD_MODELS,
  CLOUD_MODEL_LABELS,
  anthropicMaxOutputTokens,
  cloudModelDisplayLabel,
  getModelInfo,
  inferCloudModelProvider,
  MODEL_CATALOG,
  isOpus5Model,
  supportsMidConversationSystem,
  TRACKED_MODELS,
} from './model-catalog.ts'

describe('model catalog', () => {
  it('has a generated entry for every tracked model (run `npm run sync:models` if this fails)', () => {
    const missing = TRACKED_MODELS.filter((m) => !(m in MODEL_CATALOG))
    assert.deepEqual(
      missing,
      [],
      `MODEL_CATALOG is missing entries for: ${missing.join(', ')}. Re-run \`npm run sync:models\` to regenerate model-catalog.generated.ts, or remove the id from TRACKED_MODELS if it is no longer shipped.`,
    )
  })

  it('exposes positive prices, context window, and max output tokens for every entry', () => {
    for (const [model, info] of Object.entries(MODEL_CATALOG)) {
      assert.ok(info.inputPricePerMTok > 0, `${model}: inputPricePerMTok must be > 0`)
      assert.ok(info.outputPricePerMTok > 0, `${model}: outputPricePerMTok must be > 0`)
      assert.ok(info.contextWindow > 0, `${model}: contextWindow must be > 0`)
      assert.ok(info.maxOutputTokens > 0, `${model}: maxOutputTokens must be > 0`)
    }
  })

  it('includes Anthropic cache pricing when prompt caching is supported', () => {
    for (const model of TRACKED_MODELS) {
      if (!model.startsWith('claude')) continue
      const info = MODEL_CATALOG[model]
      assert.ok(
        info?.cacheReadPricePerMTok && info.cacheReadPricePerMTok > 0,
        `${model}: cache read`,
      )
      assert.ok(
        info.cacheCreationPricePerMTok && info.cacheCreationPricePerMTok > 0,
        `${model}: cache creation`,
      )
      assert.ok(info.cacheReadPricePerMTok < info.inputPricePerMTok)
    }
  })

  it('getModelInfo returns null for unknown models without throwing', () => {
    assert.equal(getModelInfo('not-a-real-model'), null)
    assert.equal(getModelInfo(''), null)
  })

  it('derives cloud model picker options from TRACKED_MODELS', () => {
    assert.deepEqual(
      CLOUD_MODELS.map(([value]) => value),
      [...TRACKED_MODELS],
    )
    for (const [value, label, provider] of CLOUD_MODELS) {
      assert.equal(label, CLOUD_MODEL_LABELS[value])
      assert.notEqual(label, value, `${value}: picker label should be human-readable`)
      assert.match(label, /^[A-Z]/, `${value}: label should start with a capital letter`)
      assert.equal(provider, inferCloudModelProvider(value))
    }
  })

  it('maps tracked cloud ids to friendly display labels', () => {
    assert.equal(cloudModelDisplayLabel('claude-sonnet-4-6'), 'Claude Sonnet 4.6')
    assert.equal(cloudModelDisplayLabel('claude-opus-4-8'), 'Claude Opus 4.8')
    assert.equal(cloudModelDisplayLabel('gpt-4o-mini'), 'GPT-4o mini')
    assert.equal(cloudModelDisplayLabel('not-a-tracked-model'), 'not-a-tracked-model')
  })

  it('infers provider from model id prefix', () => {
    assert.equal(inferCloudModelProvider('claude-sonnet-4-6'), 'anthropic')
    assert.equal(inferCloudModelProvider('gpt-4o'), 'openai')
    assert.throws(() => inferCloudModelProvider('llama-3'), /Unknown cloud model provider/)
  })

  it('returns the catalog maxOutputTokens for tracked Claude models', () => {
    for (const model of TRACKED_MODELS) {
      if (!model.startsWith('claude')) continue
      assert.equal(anthropicMaxOutputTokens(model), MODEL_CATALOG[model]?.maxOutputTokens)
    }
  })

  it('falls back to 8192 max output for unknown Anthropic models', () => {
    assert.equal(anthropicMaxOutputTokens('claude-unknown'), 8192)
  })

  it('allows mid-conversation system messages only on models that accept them', () => {
    assert.equal(supportsMidConversationSystem('claude-opus-4-8'), true)
    assert.equal(supportsMidConversationSystem('claude-fable-5'), true)
    // Prefix match so dated snapshots and suffixed routing ids resolve too.
    assert.equal(supportsMidConversationSystem('claude-opus-5-20260101'), true)

    // Sending a system turn to any of these is a 400 — the default cloud model
    // included, so the `<system-reminder>` fallback is the common path.
    assert.equal(supportsMidConversationSystem('claude-sonnet-4-6'), false)
    assert.equal(supportsMidConversationSystem('claude-sonnet-5'), false)
    assert.equal(supportsMidConversationSystem('claude-haiku-4-5'), false)
    // Unknown ids default to the safe path rather than guessing.
    assert.equal(supportsMidConversationSystem('claude-unknown'), false)
    assert.equal(supportsMidConversationSystem('gpt-5'), false)
  })

  it('identifies the Opus 5 family without catching neighbouring Opus ids', () => {
    assert.equal(isOpus5Model('claude-opus-5'), true)
    // Prefix match so dated snapshots and suffixed routing ids resolve too.
    assert.equal(isOpus5Model('claude-opus-5-20260101'), true)

    assert.equal(isOpus5Model('claude-opus-4-8'), false)
    assert.equal(isOpus5Model('claude-sonnet-5'), false)
    assert.equal(isOpus5Model('claude-fable-5'), false)
    assert.equal(isOpus5Model('gpt-5'), false)
  })
})
