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
 * The `copse.model-comparison` pack: manifest declares the native tool
 * (`tools.native`) and the pack-scoped `autoOnReview` setting; runtime
 * contributions carry the same tool name so `activeToolNames()` reports it
 * while enabled (the atomicity contract test in `pack-registry.test.ts`
 * asserts that `disable()` clears the active tool list in one flag flip).
 */
export const modelComparisonPack: RegisteredPack = definePack(
  {
    name: MODEL_COMPARISON_PACK_ID,
    description:
      'Model comparison — runs the working-diff review through two configured models and a judge that compares their verdicts; on-demand via the `compare_models` tool, optionally after every editing turn.',
    trust: 'first-party',
    tools: { native: [MODEL_COMPARISON_TOOL_NAME] },
    storage: { namespace: MODEL_COMPARISON_PACK_ID },
  },
  {
    toolNames: [MODEL_COMPARISON_TOOL_NAME],
  },
)
