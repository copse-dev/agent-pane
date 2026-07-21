// The `copse.advisor-strategy` first-party pack.
//
// Bundles the experimental "advisor strategy" feature (issue #566) behind a
// single lifecycle flag. The pack declares the `advisor` native tool
// (registered host-side in `registry-bootstrap.ts`); the runtime call site
// reads `packRegistry.isEnabled('copse.advisor-strategy')` to decide whether to
// register the tool for the model tool list, so a Settings > Packs disable
// drops it in one atomic flag flip (decision 15).
//
// **No-double-registration.** Historically the `advisor` tool was registered
// when the top-level `advisorStrategyEnabled` boolean was on. That standalone
// setting is gone (`ADVISOR_STRATEGY_ENABLED_SETTING` deleted, the
// `advisorStrategyEnabled` checkbox removed from `settings-dialog.ts`) — the
// pack toggle is the master switch. Registering the tool via both the pack gate
// and the deleted standalone setting would have double-consulted the enable
// state; the deletions happen in the same change to keep a single source of
// truth (`isEnabled(ADVISOR_STRATEGY_PACK_ID)`).
//
// The orthogonal `advisorModel` setting — which model the advisor consults, also
// used by the settings pair-hint — stays a top-level setting: it is not the
// master switch, only which model the strategy uses.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// tool registration + live sync) reads the pack registry via the shared
// `getDefaultPackRegistry()` seam.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const ADVISOR_STRATEGY_PACK_ID = 'copse.advisor-strategy'

/** The native tool name the pack contributes while enabled. */
export const ADVISOR_STRATEGY_TOOL_NAME = 'advisor'

/**
 * The `copse.advisor-strategy` pack: manifest declares the native tool
 * (`tools.native`) and pack-scoped storage; runtime contributions carry the
 * same tool name so `activeToolNames()` reports it while enabled (the atomicity
 * contract test in `pack-registry.test.ts` asserts that `disable()` clears the
 * active tool list in one flag flip).
 */
export const advisorStrategyPack: RegisteredPack = definePack(
  {
    name: ADVISOR_STRATEGY_PACK_ID,
    description:
      'Advisor strategy — consult a larger advisor model mid-task via the `advisor` tool, forwarding the full transcript and verified repo state for strategic guidance (planning, getting unstuck, final review), so the everyday loop can run on a cheaper or on-device model.',
    trust: 'first-party',
    tools: { native: [ADVISOR_STRATEGY_TOOL_NAME] },
    storage: { namespace: ADVISOR_STRATEGY_PACK_ID },
  },
  {
    toolNames: [ADVISOR_STRATEGY_TOOL_NAME],
  },
)
