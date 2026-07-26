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
//  - `advisorStrategyPack` — the first-party pack for the experimental
//    client-side advisor strategy (issue #566). Declares the `advisor` tool;
//    the pack toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the pack registry). The orthogonal
//    `advisorModel` setting (which model the advisor consults) stays top-level.
//  - `okfMemoriesPack` — the first-party pack for the experimental OKF memories
//    feature. Declares the `remember`/`recall` tools and the memory steering
//    prompt block; the pack toggle atomically drops the tools from the model
//    tool list (`registry-bootstrap.ts` reads the pack registry), stops
//    appending the prompt block (`agent-system-prompt.ts`), and hides the
//    renderer Memories pane (which reads the pack's enablement via `packs:list`).
//  - `ciInvestigatorPack` — the first-party pack for the experimental CI
//    investigator subagent. Declares the `investigate_ci` tool plus its
//    deep-log `gh_run_list` / `gh_run_view` helpers; the pack toggle atomically
//    drops all three from the model tool list (`registry-bootstrap.ts` reads the
//    pack registry, ANDing `gh` availability into the register direction) and
//    re-points the "Investigate CI failure" follow-up.
//  - `forcedPlanningPack` — the first-party pack for the experimental
//    forced-planning feature. Contributes one turn-start hook that thresholds on
//    the *measured capability of the model running the turn* and injects a
//    mandatory plan-first block below it; the pack toggle atomically drops the
//    hook from the assembly pipeline (`createHookRegistry` folds pack hooks in),
//    restoring a byte-identical system prompt. Ships disabled — the host applies
//    that default once in `pack-service.ts`.
//  - `piiRedactionPack` — the first-party pack for the experimental client-side
//    PII redaction feature. Declares the `reveal_pii` tool + the redaction
//    steering prompt block; the pack toggle atomically drops the tool from the
//    model tool list, stops appending the prompt block, and stops rewriting the
//    user's input into placeholders (`registry-bootstrap.ts`,
//    `agent-system-prompt.ts` and `pii-redactor.ts` read the pack registry).
import type { RegisteredPack } from './pack-manifest.ts'
import { PackRegistry } from './pack-registry.ts'
import { todosPack } from './todos-pack.ts'
import { postTurnReviewPack } from './post-turn-review-pack.ts'
import { modelComparisonPack } from './model-comparison-pack.ts'
import { longHorizonTasksPack } from './long-horizon-tasks-pack.ts'
import { roadmapPlansPack } from './roadmap-plans-pack.ts'
import { advisorStrategyPack } from './advisor-strategy-pack.ts'
import { okfMemoriesPack } from './okf-memories-pack.ts'
import { ciInvestigatorPack } from './ci-investigator-pack.ts'
import { piiRedactionPack } from './pii-redaction-pack.ts'
import { forcedPlanningPack } from './forced-planning-pack.ts'
import { automationsPack } from './automations-pack.ts'

/**
 * Every pack Copse ships. Order is preserved as the Settings pack-list
 * enumeration order (P3): the pilot todos pack, then P5's two extracted
 * feature packs (post-turn review + model comparison), then long-horizon
 * tasks, then roadmap plans, then advisor strategy, then OKF memories, then
 * the CI investigator, then PII redaction, then forced planning.
 */
export const FIRST_PARTY_PACKS: readonly RegisteredPack[] = [
  todosPack,
  postTurnReviewPack,
  modelComparisonPack,
  longHorizonTasksPack,
  roadmapPlansPack,
  advisorStrategyPack,
  okfMemoriesPack,
  ciInvestigatorPack,
  piiRedactionPack,
  forcedPlanningPack,
  automationsPack,
]

/** A fresh {@link PackRegistry} seeded with the shipped first-party packs (all enabled). */
export function createFirstPartyPackRegistry(): PackRegistry {
  const registry = new PackRegistry()
  for (const pack of FIRST_PARTY_PACKS) registry.register(pack)
  return registry
}
