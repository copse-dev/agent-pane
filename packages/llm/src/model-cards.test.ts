import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { huggingFaceCardUrl, resolveModelCardId, MODEL_CARDS } from './model-cards.ts'
import { resolveIntellectModelId } from './model-intellect.ts'
import { TRACKED_MODELS } from './model-catalog.ts'

describe('model cards', () => {
  it('keys every card on a model id the rest of the app can reach', () => {
    // A card filed under a typo'd id is invisible: nothing in the app would
    // ever resolve to it. Every key must be a tracked cloud model or an
    // intellect-scored id (the two id spaces the value map plots).
    const tracked: readonly string[] = TRACKED_MODELS
    const unreachable = Object.keys(MODEL_CARDS).filter(
      (id) => !tracked.includes(id) && resolveIntellectModelId(id) === null,
    )
    assert.deepEqual(
      unreachable,
      [],
      `Cards filed under unknown model ids: ${unreachable.join(', ')}. Fix the modelId in scripts/data/model-cards.json and re-run \`npm run sync:model-cards\`.`,
    )
  })

  it('publishes every card over https with a title and publisher', () => {
    for (const [id, card] of Object.entries(MODEL_CARDS)) {
      assert.ok(card.url.startsWith('https://'), `${id}: card URL must be https`)
      assert.ok(card.title.length > 0, `${id}: card needs a title`)
      assert.ok(card.publisher.length > 0, `${id}: card needs a publisher`)
    }
  })

  it('resolves a card through the intellect alias table, so aliases live in one place', () => {
    // `anthropic/claude-opus-4-8` is an alias in scripts/data/intellect-scores.json
    // and is deliberately NOT repeated in scripts/data/model-cards.json.
    assert.equal(resolveIntellectModelId('anthropic/claude-opus-4-8'), 'claude-opus-4-8')
    assert.equal(resolveModelCardId('anthropic/claude-opus-4-8'), 'claude-opus-4-8')
    assert.equal(resolveModelCardId('openrouter:anthropic/claude-opus-4-8'), 'claude-opus-4-8')
  })
})

describe('huggingFaceCardUrl', () => {
  it('derives the repo README — the model card — for a router id', () => {
    assert.equal(
      huggingFaceCardUrl('huggingface:zai-org/GLM-5.2'),
      'https://huggingface.co/zai-org/GLM-5.2',
    )
  })

  it('drops the serving-route suffix, which picks a partner not a set of weights', () => {
    assert.equal(
      huggingFaceCardUrl('huggingface:zai-org/GLM-5.2:deepinfra'),
      'https://huggingface.co/zai-org/GLM-5.2',
    )
    assert.equal(
      huggingFaceCardUrl('huggingface:mistralai/Mistral-Small-24B-Instruct:fastest'),
      'https://huggingface.co/mistralai/Mistral-Small-24B-Instruct',
    )
  })

  it('refuses ids that did not come from the HF router', () => {
    // The local catalog stores lower-cased, sometimes forward-looking ids
    // (`qwen/qwen3.6-35b-a3b`) that need not name a real repo, and OpenRouter
    // has its own namespace. Deriving a *certain* URL from either would
    // manufacture 404s — the resolver may try them, this must not.
    assert.equal(huggingFaceCardUrl('qwen/qwen3.6-35b-a3b'), null)
    assert.equal(huggingFaceCardUrl('openrouter:qwen/qwen3-32b'), null)
    assert.equal(huggingFaceCardUrl('lmstudio:qwen/qwen3.6-35b-a3b'), null)
    assert.equal(huggingFaceCardUrl('claude-opus-4-8'), null)
  })

  it('refuses a router id that is not a two-segment repo path', () => {
    assert.equal(huggingFaceCardUrl('huggingface:GLM-5.2'), null)
    assert.equal(huggingFaceCardUrl('huggingface:a/b/c'), null)
    assert.equal(huggingFaceCardUrl('huggingface:'), null)
  })
})
