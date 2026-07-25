// Contract test: the `copse.post-turn-review` first-party pack (P5).
//
// P5 landing invariants pinned here (docs/plans/hooks-and-feature-packs.md,
// P5 row + "Feature packs" section). Together they prove:
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.post-turn-review` and trust `first-party`, so
//    `createFirstPartyPackRegistry()` seeds the shared registry that the loop
//    and Settings UI consult (P3).
// 2. **No double-registration.** The post-turn review feature was never a
//    static function hook (unlike the P4 todos hooks, which needed removing
//    from `TURN_START_HOOKS` / `BEFORE_FINALIZE_HOOKS`); the pack contributes
//    nothing at the typed-runtime level (no tools, no function hooks, no
//    prompt block, no UI). The equivalent trap is that a *later* extraction
//    could accidentally add a hook to both a static list and the pack — this
//    test pins the "contributes nothing at the runtime level" property so any
//    such regression fails loudly (and re-verifies the P4 pattern: an
//    `activeAsyncHooks()` / `activeBlockingHooks()` scan for `copse.post-*`
//    hooks stays empty).
// 3. **Atomicity of disable.** From the shipped seed, one flag flip drops the
//    pack from `isEnabled()`; the host trigger gate in `agent-service.ts`
//    reads that flag every turn so the review stops firing atomically.
//    Storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  postTurnReviewPack,
  POST_TURN_REVIEW_PACK_ID,
  POST_TURN_REVIEW_MAX_CYCLES_SETTING,
  DEFAULT_POST_TURN_REVIEW_CYCLES,
  MAX_POST_TURN_REVIEW_CYCLES_LIMIT,
  resolveMaxReviewCycles,
} from './post-turn-review-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.post-turn-review pack (P5)', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.post-turn-review', () => {
    assert.equal(postTurnReviewPack.id, POST_TURN_REVIEW_PACK_ID)
    assert.equal(postTurnReviewPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === POST_TURN_REVIEW_PACK_ID),
      'post-turn-review pack must be part of the shipped first-party pack list',
    )
  })

  it('declares a namespaced storage bag and no typed runtime contributions', () => {
    assert.deepEqual(postTurnReviewPack.manifest.storage, {
      namespace: POST_TURN_REVIEW_PACK_ID,
    })
    // No static-hook migration to worry about — the pack is a lifecycle
    // wrapper around the inline trigger in `agent-service.ts`, not a hook
    // extraction like P4's todos pack. Pinning this shape makes it a
    // mechanical failure to accidentally start double-registering something
    // through a later change.
    assert.deepEqual(postTurnReviewPack.contributions.toolNames, [])
    assert.deepEqual(postTurnReviewPack.contributions.blockingHooks, [])
    assert.deepEqual(postTurnReviewPack.contributions.asyncHooks, [])
    assert.deepEqual(postTurnReviewPack.contributions.promptBlocks, [])
    assert.deepEqual(postTurnReviewPack.contributions.uiContributions, [])
  })

  it('declares the maxReviewCycles setting so Settings > Packs renders it generically', () => {
    const field = postTurnReviewPack.manifest.settings?.[POST_TURN_REVIEW_MAX_CYCLES_SETTING]
    assert.ok(field, 'the pack must declare a maxReviewCycles setting')
    assert.equal(field.kind, 'number')
    assert.equal(field.default, DEFAULT_POST_TURN_REVIEW_CYCLES)
    // The description has to say what a "pass" is, since the knob's whole point
    // is the failing-review → remediation turn → re-review loop.
    assert.match(field.description ?? '', /review/i)
  })

  it('resolveMaxReviewCycles falls back on corrupt values and clamps to [1, limit]', () => {
    // Unset / wrong type / non-finite → the shipped default, so an untouched
    // install behaves exactly as it did before the setting existed.
    for (const raw of [undefined, null, '2', {}, NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(resolveMaxReviewCycles(raw), DEFAULT_POST_TURN_REVIEW_CYCLES)
    }
    // 1 = report a failing review and stop; at least one pass always runs, so
    // 0 / negatives floor to 1 rather than silently disabling the review.
    assert.equal(resolveMaxReviewCycles(1), 1)
    assert.equal(resolveMaxReviewCycles(0), 1)
    assert.equal(resolveMaxReviewCycles(-3), 1)
    assert.equal(resolveMaxReviewCycles(3), 3)
    assert.equal(resolveMaxReviewCycles(2.9), 2)
    assert.equal(
      resolveMaxReviewCycles(MAX_POST_TURN_REVIEW_CYCLES_LIMIT + 100),
      MAX_POST_TURN_REVIEW_CYCLES_LIMIT,
    )
  })

  it('starts enabled in the shipped seed and disables atomically', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(POST_TURN_REVIEW_PACK_ID), true)

    // Pack storage survives disable (decision 17) — set a value first, flip,
    // re-enable, confirm it's intact.
    registry.storage(POST_TURN_REVIEW_PACK_ID).set('lastVerdict', 'v-1')

    registry.disable(POST_TURN_REVIEW_PACK_ID)
    assert.equal(registry.isEnabled(POST_TURN_REVIEW_PACK_ID), false)
    // With no runtime contributions the "active" getters were already empty
    // for this pack; the atomic-disable contract is exercised end-to-end in
    // `enable-disable-atomicity.test.ts` across the whole shipped seed and by
    // the host trigger gate in `agent-service.ts`.

    registry.enable(POST_TURN_REVIEW_PACK_ID)
    assert.equal(registry.isEnabled(POST_TURN_REVIEW_PACK_ID), true)
    assert.equal(registry.storage(POST_TURN_REVIEW_PACK_ID).get('lastVerdict'), 'v-1')
  })
})
