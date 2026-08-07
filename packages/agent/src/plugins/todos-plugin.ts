// The `copse.todos` first-party plugin — P4 of the feature-plugin layer.
//
// This is the pilot plugin: it bundles every declared surface of the todos
// feature (docs/plans/hooks-and-feature-packs.md, "Pilot plugin: todos") behind a
// single lifecycle flag. The manifest declares the tool name (`update_todos`),
// the steering prompt block, the level-2 declarative panel contribution, and a
// namespaced storage bag; the runtime contributions register the plugin's typed
// function hooks — `todo-steering`, `todo-pin` (turn start) and
// `todo-finalize-closeout` (before-finalize) — through the same `PluginRegistry`
// the loop reads every turn (P1/P3). Disabling the plugin therefore drops the
// tool from the model tool list **and** the hooks from the assembly pipeline
// **and** the plugin-panel slot from new content in one atomic flag flip
// (decisions 15/17, pinned by the P1 atomicity contract test).
//
// **Trap:** the todos hooks (`todoSteeringHook`, `todoPinHook`,
// `todoFinalizeCloseoutHook`) used to be baked into the static
// `FIRST_PARTY_HOOKS` list (`hook-registry.ts`) via `TURN_START_HOOKS` /
// `BEFORE_FINALIZE_HOOKS`. Registering them here **without** removing them
// there would double-register (a P4 landing check). They are dropped from
// those static lists in the same change; only the non-todo entries
// (`github-link-steering`, `commit-steering`) remain.
//
// **Decision 17 invariant.** The plugin's *emission* (agent-service pumps
// `panel_update` through the plugin contribution id when the plugin is enabled)
// applies to new work only. Historical `todo_update` chunks + persisted
// `thread.todos` continue to render from shipped renderer code without ever
// consulting the plugin registry — proven mechanically by
// `history-never-consults-live-registration.test.ts`, which stays green after
// this extraction.
//
// Electron-free (execution-guidance rule 4): pure declarations + typed
// function hooks. Host emission wiring lives in `src/main/services/agent-service.ts`.
import {
  definePlugin,
  type RegisteredPlugin,
  type PluginUiContribution,
} from './plugin-manifest.ts'
import type { PanelContributionDecl } from './plugin-panel.ts'
import { todoSteeringHook, todoPinHook } from '../hooks/turn-start-hooks.ts'
import { todoFinalizeCloseoutHook } from '../hooks/before-finalize-hooks.ts'
import { TODO_STEERING_PROMPT } from '../todo-steering.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const TODOS_PLUGIN_ID = 'copse.todos'

/** The tool name the plugin contributes to the model tool list while enabled. */
export const TODOS_TOOL_NAME = 'update_todos'

/** Contribution id for the level-2 plan panel (Settings + `panel_update` payloads). */
export const TODOS_PANEL_CONTRIBUTION_ID = 'plan'

/**
 * Level-2 declarative panel decl (P2). The host renders one generic list per
 * `panel_update` payload the plugin emits (see agent-service); shape is pinned
 * at register time via {@link PanelContributionDecl} so a compromised emitter
 * can't change the panel kind mid-flight.
 */
const TODOS_PANEL_DECL: PanelContributionDecl = {
  kind: 'list',
  header: 'To-dos',
  ariaLabel: 'To-dos',
}

/** The manifest's ui slot for the level-2 plan panel. */
export const TODOS_PANEL_UI: PluginUiContribution = {
  id: TODOS_PANEL_CONTRIBUTION_ID,
  level: 2,
  slot: 'conversation-panel',
  title: 'To-dos',
  panel: TODOS_PANEL_DECL,
}

/** The manifest's steering prompt block (framed as trusted first-party text). */
const TODOS_PROMPT_BLOCK = {
  id: 'todo-steering-block',
  text: TODO_STEERING_PROMPT,
  trust: 'trusted' as const,
}

/**
 * The `copse.todos` plugin: manifest slots + typed runtime contributions.
 *
 * The declarative slots are what a user plugin could describe in `plugin.json`
 * (decision 15); the runtime contributions are the first-party privilege —
 * typed function hooks that only shipped code can register. The published
 * plugin schema (`schemas/copse-plugin.schema.json`) accepts everything in the
 * manifest below unchanged.
 */
export const todosPlugin: RegisteredPlugin = definePlugin(
  {
    name: TODOS_PLUGIN_ID,
    description:
      'Structured plan pilot plugin — owns the `update_todos` tool, todo steering + closeout hooks, and the plan panel contribution.',
    trust: 'first-party',
    stability: 'stable',
    tools: { native: [TODOS_TOOL_NAME] },
    prompt: [TODOS_PROMPT_BLOCK],
    ui: [TODOS_PANEL_UI],
    storage: { namespace: TODOS_PLUGIN_ID },
    settings: {
      steeringEnabled: {
        kind: 'boolean',
        title: 'Suggest a plan for multi-step work',
        description:
          'When on, the turn-start steering hook nudges the model to open a plan for refactor / multi-file work.',
        default: true,
      },
    },
  },
  {
    toolNames: [TODOS_TOOL_NAME],
    // Hook registration order matches the previous inline order so the
    // assembled system prompt stays byte-identical when the plugin is enabled
    // (the M0.2 / M0.3 pinning invariant carries through).
    blockingHooks: [todoSteeringHook, todoPinHook, todoFinalizeCloseoutHook],
    promptBlocks: [TODOS_PROMPT_BLOCK],
    uiContributions: [TODOS_PANEL_UI],
  },
)
