// First-party packs — the static list of feature packs Copse ships.
//
// Following decision 15 (VS Code's built-in-extensions model), first-party
// packs share the manifest, registry, and disable semantics with user packs;
// they additionally supply typed runtime contributions (native tools,
// in-process function hooks, real renderer views).
//
// **Membership.**
//  - `noopPack` — the P1 skeleton pack. Contributes nothing, kept so the
//    lifecycle stays exercised end-to-end (registry grouping, atomic
//    enable/disable, the `createHookRegistry` seam) even when the todos pack
//    is disabled.
//  - `todosPack` — the P4 pilot pack. Bundles the `update_todos` tool, the
//    turn-start steering + closeout hooks, the plan panel contribution, and
//    the pack-scoped steering setting. Disabling it removes all four in one
//    atomic flag flip (P1 atomicity, pinned by
//    `enable-disable-atomicity.test.ts`).
//  - `postTurnReviewPack` — the P5 first-party pack for post-turn review.
//    Declarative-only (no typed contributions); the pack toggle is the atomic
//    master switch consulted by the trigger site in `agent-service.ts`.
//  - `modelComparisonPack` — the P5 first-party pack for the experimental
//    two-model + judge diff comparison. Declares the `compare_models` tool;
//    the pack toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the pack registry) and skips the
//    auto-on-review trigger in `agent-service.ts`.
import { definePack, type RegisteredPack } from './pack-manifest.ts'
import { PackRegistry } from './pack-registry.ts'
import { todosPack } from './todos-pack.ts'
import { postTurnReviewPack } from './post-turn-review-pack.ts'
import { modelComparisonPack } from './model-comparison-pack.ts'

/**
 * The P1 skeleton first-party pack. Contributes nothing (empty contributions),
 * so registering it and folding its hooks into `createHookRegistry` is
 * byte-identical to not having it. It stays past P4 as a permanent smoke test
 * of the pack lifecycle: an always-registered, never-contributing pack proves
 * `disable(id)` is idempotent on a pack with zero contributions.
 */
export const noopPack: RegisteredPack = definePack({
  name: 'copse.noop',
  description: 'Skeleton pack — proves the pack lifecycle; contributes nothing.',
  trust: 'first-party',
  storage: { namespace: 'copse.noop' },
})

/**
 * Every pack Copse ships. Order is preserved as the Settings pack-list
 * enumeration order (P3); the noop skeleton stays first so it is a stable
 * anchor for the settings e2e, then the pilot todos pack, and P5's two
 * newly-extracted feature packs (post-turn review + model comparison).
 */
export const FIRST_PARTY_PACKS: readonly RegisteredPack[] = [
  noopPack,
  todosPack,
  postTurnReviewPack,
  modelComparisonPack,
]

/** A fresh {@link PackRegistry} seeded with the shipped first-party packs (all enabled). */
export function createFirstPartyPackRegistry(): PackRegistry {
  const registry = new PackRegistry()
  for (const pack of FIRST_PARTY_PACKS) registry.register(pack)
  return registry
}
