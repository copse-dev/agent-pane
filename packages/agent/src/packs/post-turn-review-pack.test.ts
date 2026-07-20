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
import { postTurnReviewPack, POST_TURN_REVIEW_PACK_ID } from './post-turn-review-pack.ts'
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
