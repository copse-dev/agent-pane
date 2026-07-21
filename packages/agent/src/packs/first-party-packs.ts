// First-party packs — the static list of feature packs Copse ships.
//
// Following decision 15 (VS Code's built-in-extensions model), first-party
// packs share the manifest, registry, and disable semantics with user packs;
// they additionally supply typed runtime contributions (native tools,
// in-process function hooks, real renderer views).
//
// **Membership.**
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
//  - `longHorizonTasksPack` — the first-party pack for the experimental
//    long-horizon tasks feature (issue #558). Declares the `track_long_task`
//    tool; the pack toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the pack registry).
//  - `roadmapPlansPack` — the first-party pack for the experimental roadmap
//    plans feature (issue #556). Declares the `roadmap_plan` tool; the pack
//    toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the pack registry) and gates the renderer's
//    Roadmap pane visibility.
import type { RegisteredPack } from './pack-manifest.ts'
import { PackRegistry } from './pack-registry.ts'
import { todosPack } from './todos-pack.ts'
import { postTurnReviewPack } from './post-turn-review-pack.ts'
import { modelComparisonPack } from './model-comparison-pack.ts'
import { longHorizonTasksPack } from './long-horizon-tasks-pack.ts'
import { roadmapPlansPack } from './roadmap-plans-pack.ts'

/**
 * Every pack Copse ships. Order is preserved as the Settings pack-list
 * enumeration order (P3): the pilot todos pack, then P5's two extracted
 * feature packs (post-turn review + model comparison), then long-horizon
 * tasks, then roadmap plans.
 */
export const FIRST_PARTY_PACKS: readonly RegisteredPack[] = [
  todosPack,
  postTurnReviewPack,
  modelComparisonPack,
  longHorizonTasksPack,
  roadmapPlansPack,
]

/** A fresh {@link PackRegistry} seeded with the shipped first-party packs (all enabled). */
export function createFirstPartyPackRegistry(): PackRegistry {
  const registry = new PackRegistry()
  for (const pack of FIRST_PARTY_PACKS) registry.register(pack)
  return registry
}
