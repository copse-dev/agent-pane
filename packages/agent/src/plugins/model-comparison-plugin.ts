// The `copse.model-comparison` first-party plugin — P5 of the feature-plugin layer.
//
// Bundles the experimental "compare two models on the working diff" feature
// behind a single lifecycle flag. The plugin declares the `compare_models`
// native tool (registered host-side in `registry-bootstrap.ts`) and the
// auto-on-review trigger's declarative surface; the runtime call sites in
// `agent-service.ts` and `registry-bootstrap.ts` read
// `pluginRegistry.isEnabled('copse.model-comparison')` to decide whether to
// register the tool for the model tool list and whether to fire the
// auto-on-review comparison inline, so a Settings > Plugins disable drops both
// in one atomic flag flip (decision 15).
//
// **P5 no-double-registration trap.** Historically the `compare_models` tool
// was registered when `MODEL_COMPARISON_ENABLED_SETTING` was on, and the
// auto-on-review trigger read the same setting. That standalone setting is
// gone (`MODEL_COMPARISON_ENABLED_SETTING` deleted, the `modelComparisonEnabled`
// checkbox removed from `settings-dialog.ts`) — the plugin toggle is the master
// switch. Registering the tool via both the plugin gate **and** the deleted
// standalone setting would have double-consulted the enable state; the
// deletions happen in the same change to keep a single source of truth
// (`isEnabled(POST_TURN_MODEL_COMPARISON_PLUGIN_ID)`).
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring
// (the tool registration + live sync + the auto-trigger gate) reads the plugin
// registry via the shared `getDefaultPluginRegistry()` seam.
import { BEST_INTELLECT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const MODEL_COMPARISON_PLUGIN_ID = 'copse.model-comparison'

/** The native tool name the plugin contributes while enabled. */
export const MODEL_COMPARISON_TOOL_NAME = 'compare_models'

/**
 * Plugin-scoped setting ids for the three comparison models. These match the
 * retired top-level store keys (`comparisonModelA` / `comparisonModelB` /
 * `comparisonJudgeModel`) so the migration in `plugin-service.ts` and the
 * `COMPARISON_*_SETTING` constants in `model-comparison.ts` (the read side) stay
 * in lockstep by value.
 */
export const COMPARISON_MODEL_A_SETTING_ID = 'comparisonModelA'
export const COMPARISON_MODEL_B_SETTING_ID = 'comparisonModelB'
export const COMPARISON_JUDGE_MODEL_SETTING_ID = 'comparisonJudgeModel'

/**
 * Default selection for reviewer B and the judge: a *rule* rather than a pinned
 * id (see `@copse/llm/dynamic-model.ts`) — reach for the most capable model the
 * user can actually reach, whatever that is on the day the comparison runs.
 *
 * Both sharing one rule is deliberate and safe: the runner expands all three
 * selections against one candidate pool, each dynamic pick avoiding the models
 * the earlier ones took (`resolveDistinctDynamicModelIds`), so they cannot
 * collapse onto the same model.
 *
 * Reviewer A keeps NO default — blank still means "the model this chat is
 * running on", which is live context no rule can express, and is why its picker
 * is the one place a comparison model is not chosen by rule alone.
 *
 * Inlined here rather than imported from the host `model-comparison.ts`
 * (`DEFAULT_COMPARISON_MODEL_B` / `DEFAULT_COMPARISON_JUDGE_MODEL`) because this
 * module is Electron-free and must not depend on `src/main`; they are pinned
 * equal by the plugin contract test.
 */
export const DEFAULT_COMPARISON_MODEL_ID = BEST_INTELLECT_MODEL_SELECTOR

/**
 * The `copse.model-comparison` plugin: manifest declares the native tool
 * (`tools.native`) and the three plugin-scoped `model` settings (reviewer A /
 * reviewer B / judge); runtime contributions carry the same tool name so
 * `activeToolNames()` reports it while enabled (the atomicity contract test in
 * `plugin-registry.test.ts` asserts that `disable()` clears the active tool list
 * in one flag flip). The `modelComparisonAutoOnReview` opt-in stays a top-level
 * setting (a fine-grained "also run automatically" toggle, read alongside the
 * plugin gate in `isAutoComparisonEnabled()`), not a plugin `model` field.
 */
export const modelComparisonPlugin: RegisteredPlugin = definePlugin(
  {
    name: MODEL_COMPARISON_PLUGIN_ID,
    description:
      'Model comparison — runs the working-diff review through two configured models and a judge that compares their verdicts; on-demand via the `compare_models` tool, optionally after every editing turn.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: [MODEL_COMPARISON_TOOL_NAME] },
    settings: {
      [COMPARISON_MODEL_A_SETTING_ID]: {
        kind: 'model',
        title: 'Reviewer A',
        description:
          'How to choose the first reviewer, resolved when the comparison runs. Leave unset to review with the model this chat is already on.',
      },
      [COMPARISON_MODEL_B_SETTING_ID]: {
        kind: 'model',
        title: 'Reviewer B',
        description:
          'How to choose the second reviewer. Always resolves to a different model than Reviewer A — two identical reviews have nothing to compare.',
        default: DEFAULT_COMPARISON_MODEL_ID,
      },
      [COMPARISON_JUDGE_MODEL_SETTING_ID]: {
        kind: 'model',
        title: 'Judge',
        description:
          'How to choose the model that compares the two reviews. Resolves to a model distinct from both reviewers whenever one is available.',
        default: DEFAULT_COMPARISON_MODEL_ID,
      },
    },
    storage: { namespace: MODEL_COMPARISON_PLUGIN_ID },
  },
  {
    toolNames: [MODEL_COMPARISON_TOOL_NAME],
  },
)
