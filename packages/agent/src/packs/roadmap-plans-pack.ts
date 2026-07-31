// The `copse.roadmap-plans` first-party pack.
//
// Bundles the experimental "roadmap plans" feature (issue #556) behind a single
// lifecycle flag. The pack declares the `roadmap_plan` native tool (registered
// host-side in `registry-bootstrap.ts`); the runtime call site reads
// `packRegistry.isEnabled('copse.roadmap-plans')` to decide whether to register
// the tool for the model tool list, so a Settings > Packs disable drops it in
// one atomic flag flip (decision 15). The renderer's Roadmap pane (titlebar
// button + command-palette entries) gates its visibility on the same pack flag.
//
// **No-double-registration.** Historically the `roadmap_plan` tool was
// registered when the top-level `roadmapPlansEnabled` boolean was on. That
// standalone setting is gone (`ROADMAP_PLANS_ENABLED_SETTING` deleted, the
// `roadmapPlansEnabled` checkbox removed from `settings-dialog.ts`) — the pack
// toggle is the master switch. Registering the tool via both the pack gate and
// the deleted standalone setting would have double-consulted the enable state;
// the deletions happen in the same change to keep a single source of truth
// (`isEnabled(ROADMAP_PLANS_PACK_ID)`).
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// tool registration + live sync) reads the pack registry via the shared
// `getDefaultPackRegistry()` seam.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const ROADMAP_PLANS_PACK_ID = 'copse.roadmap-plans'

/** The native tool name the pack contributes while enabled. */
export const ROADMAP_PLANS_TOOL_NAME = 'roadmap_plan'

/**
 * The `copse.roadmap-plans` pack: manifest declares the native tool
 * (`tools.native`) and pack-scoped storage; runtime contributions carry the
 * same tool name so `activeToolNames()` reports it while enabled (the atomicity
 * contract test in `pack-registry.test.ts` asserts that `disable()` clears the
 * active tool list in one flag flip).
 */
export const roadmapPlansPack: RegisteredPack = definePack(
  {
    name: ROADMAP_PLANS_PACK_ID,
    description:
      'Roadmap plans — a durable, per-project backlog of future-work prompts with a status lifecycle via the `roadmap_plan` tool, plus a Roadmap pane to browse and run them, so longer-horizon work is captured without being started early.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: [ROADMAP_PLANS_TOOL_NAME] },
    storage: { namespace: ROADMAP_PLANS_PACK_ID },
  },
  {
    toolNames: [ROADMAP_PLANS_TOOL_NAME],
  },
)
