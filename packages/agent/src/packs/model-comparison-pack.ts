// The `copse.model-comparison` first-party pack — P5 of the feature-pack layer.
//
// Bundles the experimental "compare two models on the working diff" feature
// behind a single lifecycle flag. The pack declares the `compare_models`
// native tool (registered host-side in `registry-bootstrap.ts`) and the
// auto-on-review trigger's declarative surface; the runtime call sites in
// `agent-service.ts` and `registry-bootstrap.ts` read
// `packRegistry.isEnabled('copse.model-comparison')` to decide whether to
// register the tool for the model tool list and whether to fire the
// auto-on-review comparison inline, so a Settings > Packs disable drops both
// in one atomic flag flip (decision 15).
//
// **P5 no-double-registration trap.** Historically the `compare_models` tool
// was registered when `MODEL_COMPARISON_ENABLED_SETTING` was on, and the
// auto-on-review trigger read the same setting. That standalone setting is
// gone (`MODEL_COMPARISON_ENABLED_SETTING` deleted, the `modelComparisonEnabled`
// checkbox removed from `settings-dialog.ts`) — the pack toggle is the master
// switch. Registering the tool via both the pack gate **and** the deleted
// standalone setting would have double-consulted the enable state; the
// deletions happen in the same change to keep a single source of truth
// (`isEnabled(POST_TURN_MODEL_COMPARISON_PACK_ID)`).
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring
// (the tool registration + live sync + the auto-trigger gate) reads the pack
// registry via the shared `getDefaultPackRegistry()` seam.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const MODEL_COMPARISON_PACK_ID = 'copse.model-comparison'

/** The native tool name the pack contributes while enabled. */
export const MODEL_COMPARISON_TOOL_NAME = 'compare_models'

/**
 * Pack-scoped setting ids for the three comparison models. These match the
 * retired top-level store keys (`comparisonModelA` / `comparisonModelB` /
 * `comparisonJudgeModel`) so the migration in `pack-service.ts` and the
 * `COMPARISON_*_SETTING` constants in `model-comparison.ts` (the read side) stay
 * in lockstep by value.
 */
export const COMPARISON_MODEL_A_SETTING_ID = 'comparisonModelA'
export const COMPARISON_MODEL_B_SETTING_ID = 'comparisonModelB'
export const COMPARISON_JUDGE_MODEL_SETTING_ID = 'comparisonJudgeModel'

/**
 * Default reviewer B / judge (a frontier Claude). Inlined here rather than
 * imported from the host `model-comparison.ts` (`DEFAULT_COMPARISON_MODEL_B` /
 * `DEFAULT_COMPARISON_JUDGE_MODEL`) because this module is Electron-free and must
 * not depend on `src/main`; the two are pinned equal by the pack contract test.
 * Reviewer A has no default — blank means "use the current chat model".
 */
export const DEFAULT_COMPARISON_MODEL_ID = 'claude-opus-4-8'

/**
 * The `copse.model-comparison` pack: manifest declares the native tool
 * (`tools.native`) and the three pack-scoped `model` settings (reviewer A /
 * reviewer B / judge); runtime contributions carry the same tool name so
 * `activeToolNames()` reports it while enabled (the atomicity contract test in
 * `pack-registry.test.ts` asserts that `disable()` clears the active tool list
 * in one flag flip). The `modelComparisonAutoOnReview` opt-in stays a top-level
 * setting (a fine-grained "also run automatically" toggle, read alongside the
 * pack gate in `isAutoComparisonEnabled()`), not a pack `model` field.
 */
export const modelComparisonPack: RegisteredPack = definePack(
  {
    name: MODEL_COMPARISON_PACK_ID,
    description:
      'Model comparison — runs the working-diff review through two configured models and a judge that compares their verdicts; on-demand via the `compare_models` tool, optionally after every editing turn.',
    trust: 'first-party',
    tools: { native: [MODEL_COMPARISON_TOOL_NAME] },
    settings: {
      [COMPARISON_MODEL_A_SETTING_ID]: {
        kind: 'model',
        title: 'Reviewer A',
        description: 'First reviewer. Leave blank to use your current chat model.',
      },
      [COMPARISON_MODEL_B_SETTING_ID]: {
        kind: 'model',
        title: 'Reviewer B',
        description:
          'Second reviewer — pick a different model than Reviewer A. Defaults to claude-opus-4-8.',
        default: DEFAULT_COMPARISON_MODEL_ID,
      },
      [COMPARISON_JUDGE_MODEL_SETTING_ID]: {
        kind: 'model',
        title: 'Judge',
        description: 'Model that compares the two reviews. Defaults to claude-opus-4-8.',
        default: DEFAULT_COMPARISON_MODEL_ID,
      },
    },
    storage: { namespace: MODEL_COMPARISON_PACK_ID },
  },
  {
    toolNames: [MODEL_COMPARISON_TOOL_NAME],
  },
)
