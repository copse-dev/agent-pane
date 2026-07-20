// The `copse.post-turn-review` first-party pack — P5 of the feature-pack layer.
//
// Bundles the "review the working diff after each editing turn" feature behind
// a single lifecycle flag. Post-turn review is orchestrated at the turn
// boundary in `agent-service.ts` (E3 landed `runPostTurnReviewCycle` as the
// pure sequencing seam) and observed by the F2 `postTurnReview` async
// Copse-native command hook; neither surface is a static function-hook
// registration like the P4 todos hooks, so the "delete inline trigger" step
// here is the direct call-site gate in `agent-service.ts`, which now reads
// `packRegistry.isEnabled('copse.post-turn-review')` as the atomic master
// switch. The former top-level `postTurnReviewEnabled` boolean setting is
// retired in the same change; the fine-grained
// `postTurnReviewMinChangedLines` threshold stays a top-level setting because
// it is orthogonal to enablement.
//
// The pack contributes nothing at the typed-runtime level (no tools, no
// function hooks, no prompt block, no UI): the review's tool set is scoped
// per-run by `filterReviewTools` inside the subagent, not offered to the parent
// model tool list, and the F2 observation event fires through the dialect
// dispatcher via `runPostTurnReviewHooks` — a fire site, not a registered
// contribution. What the pack *declares* is the pack-scoped `minChangedLines`
// setting so the Settings > Packs list can render it generically (P3), and a
// namespaced storage bag so a later user-visible feature (e.g. a per-project
// remembered spend-approval) can persist state that survives a disable
// (decision 17).
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring
// (the trigger gate in `agent-service.ts` and the F2 fire site in
// `src/main/services/hooks/post-turn-review.ts`) reads the pack registry via
// the shared `getDefaultPackRegistry()` seam.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const POST_TURN_REVIEW_PACK_ID = 'copse.post-turn-review'

/**
 * The `copse.post-turn-review` pack: declarative manifest + empty typed
 * contributions. The pack toggle in Settings > Packs is the atomic master
 * switch — disabling the pack skips the inline `runPostTurnReviewCycle` call
 * site in `agent-service.ts` and the F2 `postTurnReview` observation for new
 * turns; storage persists (decision 17).
 */
export const postTurnReviewPack: RegisteredPack = definePack({
  name: POST_TURN_REVIEW_PACK_ID,
  description:
    'Post-turn review — reads the working diff after each editing turn with a subagent and applies its todo remediation, gated by a per-chat spend approval for billable review models.',
  trust: 'first-party',
  storage: { namespace: POST_TURN_REVIEW_PACK_ID },
})
