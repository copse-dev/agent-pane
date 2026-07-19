// The `copse.todos` first-party pack — P4 of the feature-pack layer.
//
// This is the pilot pack: it bundles every declared surface of the todos
// feature (docs/plans/hooks-and-feature-packs.md, "Pilot pack: todos") behind a
// single lifecycle flag. The manifest declares the tool name (`update_todos`),
// the steering prompt block, the level-2 declarative panel contribution, and a
// namespaced storage bag; the runtime contributions register the pack's typed
// function hooks — `todo-steering`, `todo-pin` (turn start) and
// `todo-finalize-closeout` (before-finalize) — through the same `PackRegistry`
// the loop reads every turn (P1/P3). Disabling the pack therefore drops the
// tool from the model tool list **and** the hooks from the assembly pipeline
// **and** the pack-panel slot from new content in one atomic flag flip
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
// **Decision 17 invariant.** The pack's *emission* (agent-service pumps
// `panel_update` through the pack contribution id when the pack is enabled)
// applies to new work only. Historical `todo_update` chunks + persisted
// `thread.todos` continue to render from shipped renderer code without ever
// consulting the pack registry — proven mechanically by
// `history-never-consults-live-registration.test.ts`, which stays green after
// this extraction.
//
// Electron-free (execution-guidance rule 4): pure declarations + typed
// function hooks. Host emission wiring lives in `src/main/services/agent-service.ts`.
import { definePack, type RegisteredPack, type PackUiContribution } from './pack-manifest.ts'
import type { PanelContributionDecl } from './pack-panel.ts'
import { todoSteeringHook, todoPinHook } from '../hooks/turn-start-hooks.ts'
import { todoFinalizeCloseoutHook } from '../hooks/before-finalize-hooks.ts'
import { TODO_STEERING_PROMPT } from '../todo-steering.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const TODOS_PACK_ID = 'copse.todos'

/** The tool name the pack contributes to the model tool list while enabled. */
export const TODOS_TOOL_NAME = 'update_todos'

/** Contribution id for the level-2 plan panel (Settings + `panel_update` payloads). */
export const TODOS_PANEL_CONTRIBUTION_ID = 'plan'

/**
 * Level-2 declarative panel decl (P2). The host renders one generic list per
 * `panel_update` payload the pack emits (see agent-service); shape is pinned
 * at register time via {@link PanelContributionDecl} so a compromised emitter
 * can't change the panel kind mid-flight.
 */
const TODOS_PANEL_DECL: PanelContributionDecl = {
  kind: 'list',
  header: 'To-dos',
  ariaLabel: 'To-dos',
}

/** The manifest's ui slot for the level-2 plan panel. */
export const TODOS_PANEL_UI: PackUiContribution = {
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
 * The `copse.todos` pack: manifest slots + typed runtime contributions.
 *
 * The declarative slots are what a user pack could describe in `plugin.json`
 * (decision 15); the runtime contributions are the first-party privilege —
 * typed function hooks that only shipped code can register. The published
 * pack schema (`schemas/copse-pack.schema.json`) accepts everything in the
 * manifest below unchanged.
 */
export const todosPack: RegisteredPack = definePack(
  {
    name: TODOS_PACK_ID,
    description:
      'Structured plan pilot pack — owns the `update_todos` tool, todo steering + closeout hooks, and the plan panel contribution.',
    trust: 'first-party',
    tools: { native: [TODOS_TOOL_NAME] },
    prompt: [TODOS_PROMPT_BLOCK],
    ui: [TODOS_PANEL_UI],
    storage: { namespace: TODOS_PACK_ID },
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
    // assembled system prompt stays byte-identical when the pack is enabled
    // (the M0.2 / M0.3 pinning invariant carries through).
    blockingHooks: [todoSteeringHook, todoPinHook, todoFinalizeCloseoutHook],
    promptBlocks: [TODOS_PROMPT_BLOCK],
    uiContributions: [TODOS_PANEL_UI],
  },
)
