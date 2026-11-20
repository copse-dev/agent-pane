// The experimental CI investigator owns its automated-agent entry point.
// Basic workflow listing and log reads are core GitHub tools: disabling this
// plugin must not remove the primary agent's ability to inspect CI.
// Host registration still requires gh, and the investigator's existing
// subagent/read-only gates remain in force.
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const CI_INVESTIGATOR_PLUGIN_ID = 'copse.ci-investigator'

/** Only the automated investigation belongs to the plugin's atomic lifecycle. */
export const CI_INVESTIGATOR_PLUGIN_TOOL_NAMES = ['investigate_ci'] as const

export const ciInvestigatorPlugin: RegisteredPlugin = definePlugin(
  {
    name: CI_INVESTIGATOR_PLUGIN_ID,
    description:
      'Investigates failing CI runs with a read-only agent that examines the logs and reports the root cause. Start it with the "Investigate CI failure" follow-up.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: [...CI_INVESTIGATOR_PLUGIN_TOOL_NAMES] },
    storage: { namespace: CI_INVESTIGATOR_PLUGIN_ID },
  },
  {
    toolNames: [...CI_INVESTIGATOR_PLUGIN_TOOL_NAMES],
  },
)
