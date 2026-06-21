import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getModelInfo, MODEL_CATALOG, TRACKED_MODELS } from './model-catalog.ts'

describe('model catalog', () => {
  it('has a generated entry for every tracked model (run `npm run sync:models` if this fails)', () => {
    const missing = TRACKED_MODELS.filter((m) => !(m in MODEL_CATALOG))
    assert.deepEqual(
      missing,
      [],
      `MODEL_CATALOG is missing entries for: ${missing.join(', ')}. Re-run \`npm run sync:models\` to regenerate model-catalog.generated.ts, or remove the id from TRACKED_MODELS if it is no longer shipped.`,
    )
  })

  it('exposes positive prices and a positive context window for every entry', () => {
    for (const [model, info] of Object.entries(MODEL_CATALOG)) {
      assert.ok(info.inputPricePerMTok > 0, `${model}: inputPricePerMTok must be > 0`)
      assert.ok(info.outputPricePerMTok > 0, `${model}: outputPricePerMTok must be > 0`)
      assert.ok(info.contextWindow > 0, `${model}: contextWindow must be > 0`)
    }
  })

  it('getModelInfo returns null for unknown models without throwing', () => {
    assert.equal(getModelInfo('not-a-real-model'), null)
    assert.equal(getModelInfo(''), null)
  })
})
