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
// contribution. What the pack *declares* is the pack-scoped `maxReviewCycles`
// setting so the Settings > Packs list can render it generically (P3), and a
// namespaced storage bag so a later user-visible feature (e.g. a per-project
// remembered spend-approval) can persist state that survives a disable
// (decision 17). The orthogonal `postTurnReviewMinChangedLines` threshold stays
// a top-level setting.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring
// (the trigger gate in `agent-service.ts` and the F2 fire site in
// `src/main/services/hooks/post-turn-review.ts`) reads the pack registry via
// the shared `getDefaultPackRegistry()` seam.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const POST_TURN_REVIEW_PACK_ID = 'copse.post-turn-review'

/**
 * Pack-scoped setting id for "how many review passes may one turn run".
 *
 * A pass is one read-only review of the working diff. A *failing* review (one
 * whose verdict sets `requestFollowUp`) buys the parent agent one remediation
 * turn, after which the diff is reviewed again — that re-review is the next
 * pass. So `maxReviewCycles` is the knob for "do we do another post turn when a
 * review comes back failing, and how many times": `1` reports the failing
 * verdict and stops, `2` (the shipped default) allows one remediation turn +
 * re-review, higher values allow more.
 */
export const POST_TURN_REVIEW_MAX_CYCLES_SETTING = 'maxReviewCycles'

/**
 * Shipped default for {@link POST_TURN_REVIEW_MAX_CYCLES_SETTING} — one review,
 * one remediation turn on a failing verdict, one re-review. Kept in lockstep
 * with the host's `MAX_POST_TURN_REVIEW_CYCLES` (`src/shared/todos/todo-logic.ts`)
 * so an unset setting reproduces the pre-setting behaviour byte for byte; the
 * two are pinned together in `src/main/services/post-turn-orchestration.test.ts`
 * (this package is Electron-free and never imports `@shared`).
 */
export const DEFAULT_POST_TURN_REVIEW_CYCLES = 2

/**
 * Ceiling for {@link POST_TURN_REVIEW_MAX_CYCLES_SETTING}. Each remediation turn
 * also draws from the shared per-turn-tree continuation budget (decision 5), so
 * this is a second, local bound — it stops a typo in the Settings number field
 * from asking for hundreds of review passes.
 */
export const MAX_POST_TURN_REVIEW_CYCLES_LIMIT = 5

/**
 * Coerce a persisted {@link POST_TURN_REVIEW_MAX_CYCLES_SETTING} value into a
 * usable cycle count: missing / corrupt values fall back to the default, and
 * everything else is floored into `[1, MAX_POST_TURN_REVIEW_CYCLES_LIMIT]`. At
 * least one pass always runs — turning the review off entirely is the pack
 * toggle's job, not this setting's.
 */
export function resolveMaxReviewCycles(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_POST_TURN_REVIEW_CYCLES
  return Math.min(Math.max(Math.floor(raw), 1), MAX_POST_TURN_REVIEW_CYCLES_LIMIT)
}

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
  settings: {
    [POST_TURN_REVIEW_MAX_CYCLES_SETTING]: {
      kind: 'number',
      title: 'Review passes per turn',
      description:
        'How many times one turn may review the working diff. When a review reports problems the agent gets a remediation turn and the diff is reviewed again — that re-review is the next pass. Set to 1 to report a failing review and stop without another turn.',
      default: DEFAULT_POST_TURN_REVIEW_CYCLES,
    },
  },
})
