// The `copse.advisor-strategy` first-party plugin.
//
// Bundles the experimental "advisor strategy" feature (issue #566) behind a
// single lifecycle flag. The plugin declares the `advisor` native tool
// (registered host-side in `registry-bootstrap.ts`); the runtime call site
// reads `pluginRegistry.isEnabled('copse.advisor-strategy')` to decide whether to
// register the tool for the model tool list, so a Settings > Plugins disable
// drops it in one atomic flag flip (decision 15).
//
// **No-double-registration.** Historically the `advisor` tool was registered
// when the top-level `advisorStrategyEnabled` boolean was on. That standalone
// setting is gone (`ADVISOR_STRATEGY_ENABLED_SETTING` deleted, the
// `advisorStrategyEnabled` checkbox removed from `settings-dialog.ts`) — the
// plugin toggle is the master switch. Registering the tool via both the plugin gate
// and the deleted standalone setting would have double-consulted the enable
// state; the deletions happen in the same change to keep a single source of
// truth (`isEnabled(ADVISOR_STRATEGY_PLUGIN_ID)`).
//
// **The `advisorModel` setting now belongs to the plugin.** Which model the
// advisor consults is declared here as a plugin-scoped `model` setting field
// (rendered generically in Settings → Plugins from the live model catalogue), so
// the plugin fully owns its model configuration. The bespoke `<select>` block that
// used to live in `settings-dialog.ts` (and the top-level `advisorModel` store
// key) are retired in the same change; a one-time migration in `plugin-service.ts`
// lifts any existing top-level value into the plugin's settings bag. The read site
// (`resolveAdvisorModelId` in `advisor-runner.ts`) still lets a `roleModels`
// `advisor` assignment win, then falls back to this plugin setting, then the
// frontier default — so the model-roles indirection is unchanged.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// tool registration + live sync, and the plugin-setting read) reads through the
// shared `getDefaultPluginRegistry()` / plugin-service seams.
import { BEST_INTELLECT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const ADVISOR_STRATEGY_PLUGIN_ID = 'copse.advisor-strategy'

/** The native tool name the plugin contributes while enabled. */
export const ADVISOR_STRATEGY_TOOL_NAME = 'advisor'

/**
 * Plugin-scoped setting id for the advisor model. Matches the retired top-level
 * store key (`advisorModel`) so the migration and the `ADVISOR_MODEL_SETTING`
 * constant in `advisor-strategy.ts` (the read side) stay in lockstep by value.
 */
export const ADVISOR_MODEL_SETTING_ID = 'advisorModel'

/**
 * Default advisor selection: the most capable model the user can reach. Stored
 * as a *rule* rather than a pinned id (see `@copse/llm/dynamic-model.ts`) — an
 * advisor exists to be stronger than the executor, and which model that is
 * changes with the user's keys, plan window, and the models that ship next.
 * Inlined here rather than imported from the host `advisor-strategy.ts`
 * (`DEFAULT_ADVISOR_MODEL`) because this module is Electron-free and must not
 * depend on `src/main`; the two are pinned equal by the plugin contract test.
 */
export const DEFAULT_ADVISOR_MODEL_ID = BEST_INTELLECT_MODEL_SELECTOR

/**
 * The `copse.advisor-strategy` plugin: manifest declares the native tool
 * (`tools.native`), the plugin-scoped `advisorModel` model setting, and
 * plugin-scoped storage; runtime contributions carry the same tool name so
 * `activeToolNames()` reports it while enabled (the atomicity contract test in
 * `plugin-registry.test.ts` asserts that `disable()` clears the active tool list
 * in one flag flip).
 */
export const advisorStrategyPlugin: RegisteredPlugin = definePlugin(
  {
    name: ADVISOR_STRATEGY_PLUGIN_ID,
    description:
      'Advisor strategy — consult a larger advisor model mid-task via the `advisor` tool, forwarding the full transcript and verified repo state for strategic guidance (planning, getting unstuck, final review), so the everyday loop can run on a cheaper or on-device model.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: [ADVISOR_STRATEGY_TOOL_NAME] },
    settings: {
      [ADVISOR_MODEL_SETTING_ID]: {
        kind: 'model',
        title: 'Advisor model',
        description:
          'How to choose the model the advisor consults — re-derived from your configured providers each time it is called, and the advisor side of the executor/advisor pairing hint. A model assigned to the “advisor” role still takes precedence.',
        default: DEFAULT_ADVISOR_MODEL_ID,
      },
    },
    storage: { namespace: ADVISOR_STRATEGY_PLUGIN_ID },
  },
  {
    toolNames: [ADVISOR_STRATEGY_TOOL_NAME],
  },
)
