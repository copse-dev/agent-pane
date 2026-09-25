import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { CI_INVESTIGATOR_PLUGIN_ID } from '@copse/agent/plugins/ci-investigator-plugin.ts'
import { isGhAvailable } from '../tool-availability.ts'
import { getSetting } from '../storage/settings.ts'
import { SUBAGENTS_ENABLED_DEFAULT, SUBAGENTS_ENABLED_SETTING } from '../subagents-setting.ts'

/** The CI investigator's subagent entry tool. */
export const INVESTIGATE_CI_TOOL_NAME = 'investigate_ci'

/**
 * Whether the CI investigator tools can be registered: the `copse.ci-investigator`
 * plugin is enabled and `gh` is usable (the entry tool and its `gh_run_*`
 * helpers shell out to it). `syncCiInvestigatorTools` registers on this.
 */
export function ciInvestigatorToolsRegistrable(): boolean {
  return getDefaultPluginRegistry().isEnabled(CI_INVESTIGATOR_PLUGIN_ID) && isGhAvailable()
}

/**
 * Whether a parent turn is actually offered `investigate_ci`: the tools are
 * registered AND subagents are on (`parentTools` withholds subagent entry
 * tools otherwise). The one predicate every surface that names the tool to the
 * model — the system prompt's tool line and the "Investigate CI failure"
 * follow-up — must share, so neither points at a tool the turn cannot call.
 *
 * `subagentsEnabled` defaults to the live setting; a caller that has already
 * resolved it for the turn passes its value so both agree.
 */
export function isInvestigateCiOffered(
  subagentsEnabled: boolean = getSetting<boolean>(
    SUBAGENTS_ENABLED_SETTING,
    SUBAGENTS_ENABLED_DEFAULT,
  ),
): boolean {
  return subagentsEnabled && ciInvestigatorToolsRegistrable()
}
