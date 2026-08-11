// First-party plugins — the static list of feature plugins Copse ships.
//
// Following decision 15 (VS Code's built-in-extensions model), first-party
// plugins share the manifest, registry, and disable semantics with user plugins;
// they additionally supply typed runtime contributions (native tools,
// in-process function hooks, real renderer views).
//
// **Membership.**
//  - `todosPlugin` — the P4 pilot plugin. Bundles the `update_todos` tool, the
//    turn-start steering + closeout hooks, the plan panel contribution, and
//    the plugin-scoped steering setting. Disabling it removes all four in one
//    atomic flag flip (P1 atomicity, pinned by
//    `enable-disable-atomicity.test.ts`).
//  - `postTurnReviewPlugin` — the P5 first-party plugin for post-turn review.
//    Declarative-only (no typed contributions); the plugin toggle is the atomic
//    master switch consulted by the trigger site in `agent-service.ts`.
//  - `modelComparisonPlugin` — the P5 first-party plugin for the experimental
//    two-model + judge diff comparison. Declares the `compare_models` tool;
//    the plugin toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the plugin registry) and skips the
//    auto-on-review trigger in `agent-service.ts`.
//  - `longHorizonTasksPlugin` — the first-party plugin for the experimental
//    long-horizon tasks feature (issue #558). Declares the `track_long_task`
//    tool; the plugin toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the plugin registry).
//  - `roadmapPlansPlugin` — the first-party plugin for the experimental roadmap
//    plans feature (issue #556). Declares the `roadmap_plan` tool; the plugin
//    toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the plugin registry) and gates the renderer's
//    Roadmap pane visibility.
//  - `advisorStrategyPlugin` — the first-party plugin for the experimental
//    client-side advisor strategy (issue #566). Declares the `advisor` tool;
//    the plugin toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the plugin registry). The orthogonal
//    `advisorModel` setting (which model the advisor consults) stays top-level.
//  - `okfMemoriesPlugin` — the first-party plugin for the experimental OKF memories
//    feature. Declares the `remember`/`recall` tools and the memory steering
//    prompt block; the plugin toggle atomically drops the tools from the model
//    tool list (`registry-bootstrap.ts` reads the plugin registry), stops
//    appending the prompt block (`agent-system-prompt.ts`), and hides the
//    renderer Memories pane (which reads the plugin's enablement via `plugins:list`).
//  - `ciInvestigatorPlugin` — the first-party plugin for the experimental CI
//    investigator subagent. Declares the `investigate_ci` tool plus its
//    deep-log `gh_run_list` / `gh_run_view` helpers; the plugin toggle atomically
//    drops all three from the model tool list (`registry-bootstrap.ts` reads the
//    plugin registry, ANDing `gh` availability into the register direction) and
//    re-points the "Investigate CI failure" follow-up.
//  - `forcedPlanningPlugin` — the first-party plugin for the experimental
//    forced-planning feature. Contributes one turn-start hook that thresholds on
//    the *measured capability of the model running the turn* and injects a
//    mandatory plan-first block below it; the plugin toggle atomically drops the
//    hook from the assembly pipeline (`createHookRegistry` folds plugin hooks in),
//    restoring a byte-identical system prompt. Ships disabled — its id is in the
//    declared `DEFAULT_DISABLED_PLUGIN_IDS` set in `plugin-service.ts`.
//  - `piiRedactionPlugin` — the first-party plugin for the experimental client-side
//    PII redaction feature. Declares the `reveal_pii` tool + the redaction
//    steering prompt block; the plugin toggle atomically drops the tool from the
//    model tool list, stops appending the prompt block, and stops rewriting the
//    user's input into placeholders (`registry-bootstrap.ts`,
//    `agent-system-prompt.ts` and `pii-redactor.ts` read the plugin registry).
//  - `mcpUiCanvasPlugin` — the first-party plugin for the experimental MCP-UI
//    artefacts (canvas) feature (issue #611). Contributes no tool: it declares
//    the `mcp-ui-canvas` **capability** — the canvas gates in `mcp-registry.ts`
//    read `isCapabilityActive('mcp-ui-canvas')` instead of the retired
//    `mcpUiArtefactsEnabled` setting, so the plugin toggle atomically turns canvas
//    rendering (and the bundled canvas server) on/off. Default DISABLED.
//  - `devtoolsShortcutPlugin` — the first-party plugin for the experimental DevTools
//    shortcut. Contributes no tool: it declares the `devtools-shortcut`
//    **capability** — `create-main-window.ts` reads
//    `isCapabilityActive('devtools-shortcut')` instead of the retired
//    `devtoolsShortcutEnabled` setting, so the plugin toggle atomically
//    registers/unregisters the global Ctrl+Shift+I shortcut. Default DISABLED.
//  - `backgroundTasksPlugin` — the first-party plugin for the stable, default-on
//    background tasks feature (issue #691). Declares the `run_background` tool
//    AND the `loopback-bind` **permission / sandbox relaxation** (issue #1190):
//    the plugin toggle atomically drops the tool from the model tool list
//    (`registry-bootstrap.ts` reads the plugin registry) and the permission-gate
//    only grants the loopback port-binding relaxation while the plugin declares it
//    (`permission-gate.ts` reads `isPermissionDeclared('loopback-bind')`).
//    Default ENABLED; users can still disable it through the plugin toggle.
//  - `parallelSearchPlugin` — direct, credential-gated access to Parallel's
//    hosted Search API. It declares the native `parallel_search` tool, search
//    mode setting, and first-party credential detail. Default DISABLED.
//  - `siteBuildingPlugin` — stable, default-on website creative-engineering
//    steering. Contributes one conditional turn-start hook shared by the local
//    loop and ACP; no customer- or demo-specific art direction is embedded.
import type { RegisteredPlugin } from './plugin-manifest.ts'
import { PluginRegistry } from './plugin-registry.ts'
import { todosPlugin } from './todos-plugin.ts'
import { postTurnReviewPlugin } from './post-turn-review-plugin.ts'
import { modelComparisonPlugin } from './model-comparison-plugin.ts'
import { longHorizonTasksPlugin } from './long-horizon-tasks-plugin.ts'
import { roadmapPlansPlugin } from './roadmap-plans-plugin.ts'
import { advisorStrategyPlugin } from './advisor-strategy-plugin.ts'
import { okfMemoriesPlugin } from './okf-memories-plugin.ts'
import { ciInvestigatorPlugin } from './ci-investigator-plugin.ts'
import { piiRedactionPlugin } from './pii-redaction-plugin.ts'
import { forcedPlanningPlugin } from './forced-planning-plugin.ts'
import { mcpUiCanvasPlugin } from './mcp-ui-canvas-plugin.ts'
import { devtoolsShortcutPlugin } from './devtools-shortcut-plugin.ts'
import { backgroundTasksPlugin } from './background-tasks-plugin.ts'
import { automationsPlugin } from './automations-plugin.ts'
import { parallelSearchPlugin } from './parallel-search-plugin.ts'
import { darkFactoryPlugin } from './dark-factory-plugin.ts'
import { siteBuildingPlugin } from './site-building-plugin.ts'

/**
 * Every plugin Copse ships. Order is preserved as the Settings plugin-list
 * enumeration order (P3): the pilot todos plugin, then P5's two extracted
 * feature plugins (post-turn review + model comparison), then long-horizon
 * tasks, then roadmap plans, then advisor strategy, then OKF memories, then
 * the CI investigator, then PII redaction, then forced planning, then the two
 * capability-only plugins (MCP-UI canvas + DevTools shortcut), then the
 * background-tasks plugin (which declares a permission / sandbox relaxation,
 * issue #1190), then the automations prototype, Parallel Search, dark factory,
 * and the stable site-building steering plugin.
 */
export const FIRST_PARTY_PLUGINS: readonly RegisteredPlugin[] = [
  todosPlugin,
  postTurnReviewPlugin,
  modelComparisonPlugin,
  longHorizonTasksPlugin,
  roadmapPlansPlugin,
  advisorStrategyPlugin,
  okfMemoriesPlugin,
  ciInvestigatorPlugin,
  piiRedactionPlugin,
  forcedPlanningPlugin,
  mcpUiCanvasPlugin,
  devtoolsShortcutPlugin,
  backgroundTasksPlugin,
  automationsPlugin,
  parallelSearchPlugin,
  darkFactoryPlugin,
  siteBuildingPlugin,
]

/**
 * The single source of truth for first-party plugins that must ship disabled.
 * Stability is product metadata, not decorative copy: an experimental plugin is
 * opt-in by construction, so adding one cannot accidentally enable it for a
 * fresh profile while forgetting to update a second hand-maintained list.
 */
export const EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS: readonly string[] = FIRST_PARTY_PLUGINS.filter(
  (plugin) => plugin.manifest.stability === 'experimental',
).map((plugin) => plugin.id)

/** A fresh {@link PluginRegistry} seeded with the shipped first-party plugins (all enabled). */
export function createFirstPartyPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry()
  for (const plugin of FIRST_PARTY_PLUGINS) registry.register(plugin)
  return registry
}
