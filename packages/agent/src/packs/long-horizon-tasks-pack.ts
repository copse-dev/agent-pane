// The `copse.long-horizon-tasks` first-party pack.
//
// Bundles the experimental "long-horizon tasks" feature (issue #558) behind a
// single lifecycle flag. The pack declares the `track_long_task` native tool
// (registered host-side in `registry-bootstrap.ts`); the runtime call site
// reads `packRegistry.isEnabled('copse.long-horizon-tasks')` to decide whether
// to register the tool for the model tool list, so a Settings > Packs disable
// drops it in one atomic flag flip (decision 15).
//
// **No-double-registration.** Historically the `track_long_task` tool was
// registered when the top-level `longHorizonTasksEnabled` boolean was on. That
// standalone setting is gone (`LONG_HORIZON_TASKS_ENABLED_SETTING` deleted, the
// `longHorizonTasksEnabled` checkbox removed from `settings-dialog.ts`) — the
// pack toggle is the master switch. Registering the tool via both the pack gate
// and the deleted standalone setting would have double-consulted the enable
// state; the deletions happen in the same change to keep a single source of
// truth (`isEnabled(LONG_HORIZON_TASKS_PACK_ID)`).
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// tool registration + live sync) reads the pack registry via the shared
// `getDefaultPackRegistry()` seam.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const LONG_HORIZON_TASKS_PACK_ID = 'copse.long-horizon-tasks'

/** The native tool name the pack contributes while enabled. */
export const LONG_HORIZON_TASKS_TOOL_NAME = 'track_long_task'

/**
 * The `copse.long-horizon-tasks` pack: manifest declares the native tool
 * (`tools.native`) and pack-scoped storage; runtime contributions carry the
 * same tool name so `activeToolNames()` reports it while enabled (the atomicity
 * contract test in `pack-registry.test.ts` asserts that `disable()` clears the
 * active tool list in one flag flip).
 */
export const longHorizonTasksPack: RegisteredPack = definePack(
  {
    name: LONG_HORIZON_TASKS_PACK_ID,
    description:
      'Long-horizon tasks — a durable, resumable checklist for a grind task within a PR (clearing a lint/type backlog, a deep research pass) via the `track_long_task` tool, with done/remaining state that survives across sessions.',
    trust: 'first-party',
    tools: { native: [LONG_HORIZON_TASKS_TOOL_NAME] },
    storage: { namespace: LONG_HORIZON_TASKS_PACK_ID },
  },
  {
    toolNames: [LONG_HORIZON_TASKS_TOOL_NAME],
  },
)
