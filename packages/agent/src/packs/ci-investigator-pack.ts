// The `copse.ci-investigator` first-party pack.
//
// Bundles the experimental "CI investigator subagent" feature behind a single
// lifecycle flag. The pack declares three native tools — the `investigate_ci`
// entry tool plus the deep-log `gh_run_list` / `gh_run_view` helpers the
// subagent relies on (all registered host-side in `registry-bootstrap.ts`); the
// runtime call site reads `packRegistry.isEnabled('copse.ci-investigator')` to
// decide whether to register them for the model tool list, so a Settings > Packs
// disable drops all three in one atomic flag flip (decision 15).
//
// **No-double-registration.** Historically these tools were registered when the
// top-level `ciInvestigatorEnabled` boolean was on. That standalone setting is
// gone (`CI_INVESTIGATOR_ENABLED_SETTING` deleted, the `ciInvestigatorEnabled`
// checkbox removed from `settings-dialog.ts`) — the pack toggle is the master
// switch. Registering the tools via both the pack gate and the deleted
// standalone setting would have double-consulted the enable state; the deletions
// happen in the same change to keep a single source of truth
// (`isEnabled(CI_INVESTIGATOR_PACK_ID)`).
//
// The host gate keeps an additional runtime condition — the tools shell out to
// `gh`, so `registry-bootstrap.ts` ANDs `gh` availability into the sync — but
// the pack toggle remains the user-visible master switch and the "Investigate CI
// failure" follow-up pointer keys off the same pack enablement.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// tool registration + live sync) reads the pack registry via the shared
// `getDefaultPackRegistry()` seam.
import { definePack, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const CI_INVESTIGATOR_PACK_ID = 'copse.ci-investigator'

/**
 * The native tool names the pack contributes while enabled — the `investigate_ci`
 * entry tool plus the two deep-log `gh_run_*` helpers it relies on. (Distinct
 * from `run-subagent.ts`'s `CI_INVESTIGATOR_TOOL_NAMES`, which is the broader
 * allow-list of tools the subagent may *call* once running.)
 */
export const CI_INVESTIGATOR_PACK_TOOL_NAMES = [
  'gh_run_list',
  'gh_run_view',
  'investigate_ci',
] as const

/**
 * The `copse.ci-investigator` pack: manifest declares the three native tools
 * (`tools.native`) and pack-scoped storage; runtime contributions carry the
 * same tool names so `activeToolNames()` reports them while enabled (the
 * atomicity contract test in `pack-registry.test.ts` asserts that `disable()`
 * clears the active tool list in one flag flip).
 */
export const ciInvestigatorPack: RegisteredPack = definePack(
  {
    name: CI_INVESTIGATOR_PACK_ID,
    description:
      'CI investigator subagent — delegates to a read-only subagent that reads failing CI run logs in depth and reports the root cause via the `investigate_ci` tool (with the `gh_run_list` / `gh_run_view` log helpers), and points the "Investigate CI failure" follow-up at it.',
    trust: 'first-party',
    tools: { native: [...CI_INVESTIGATOR_PACK_TOOL_NAMES] },
    storage: { namespace: CI_INVESTIGATOR_PACK_ID },
  },
  {
    toolNames: [...CI_INVESTIGATOR_PACK_TOOL_NAMES],
  },
)
