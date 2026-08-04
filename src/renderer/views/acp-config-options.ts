import type { ApiClient } from '../../preload/api.d.ts'
import {
  acpConfigCategoryLabel,
  parseAcpAgentConfigs,
  parseAcpModelSelection,
} from '@shared/acp.ts'
import type { AcpAgentConfig, AcpConfigChoice } from '@shared/types/acp.ts'

/**
 * The picker-facing shape of one ACP selector: a labelled set of values, one of
 * which is current. Both of ACP v1's mechanisms flatten into this —
 * `session/set_config_option` selectors (reasoning level and anything else the
 * agent advertises) and the older `session/set_mode` state — so the UI renders
 * one kind of row and the persistence layer decides where the choice lands.
 */
export interface AcpOptionGroup {
  /** `configId` for a config option; {@link ACP_MODE_GROUP_ID} for session modes. */
  id: string
  kind: 'config' | 'mode'
  /** Agent-provided label ("Thinking effort", "Mode", …). */
  label: string
  /** Currently selected value: the user's saved choice, else the agent's default. */
  currentValue: string
  choices: AcpConfigChoice[]
}

/**
 * Sentinel id for the session-mode group. Session modes are not config options
 * in ACP v1 — they live in the `modes` state and switch via `session/set_mode`
 * — but they read as just another selector to a user, so the picker shows them
 * alongside. (ACP v2 folds modes into `configOptions` with `category: "mode"`,
 * at which point this special case collapses into the generic path.)
 */
export const ACP_MODE_GROUP_ID = '__acp_session_mode__'

/**
 * The selectors a configured agent offers, from its probe cache. Options with
 * fewer than two choices are dropped (nothing to pick), as is the `model`
 * category — models are already the picker's own list, and offering them twice
 * would let the two disagree.
 */
export function acpOptionGroupsFor(agent: AcpAgentConfig): AcpOptionGroup[] {
  const groups: AcpOptionGroup[] = []
  for (const option of agent.availableConfigOptions ?? []) {
    if (option.category === 'model' || option.choices.length < 2) continue
    groups.push({
      id: option.configId,
      kind: 'config',
      label: option.name || acpConfigCategoryLabel(option.category),
      currentValue: agent.configOptions?.[option.configId] ?? option.currentValue,
      choices: option.choices,
    })
  }
  // Only fall back to the legacy mode state when the agent did not advertise a
  // `category: "mode"` config option — otherwise the same choice would appear
  // twice, written through two different code paths.
  const hasConfigMode = (agent.availableConfigOptions ?? []).some(
    (option) => option.category === 'mode',
  )
  const modes = agent.availablePermissionModes ?? []
  if (!hasConfigMode && modes.length > 1) {
    groups.push({
      id: ACP_MODE_GROUP_ID,
      kind: 'mode',
      label: 'Mode',
      currentValue: agent.permissionMode ?? modes[0]?.value ?? '',
      choices: modes.map((mode) => ({
        value: mode.value,
        label: mode.label,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    })
  }
  return groups
}

interface AcpSettingsApi {
  settings: Pick<ApiClient['settings'], 'get' | 'set'>
}

/** Read + validate the configured agents from settings. */
async function readAgents(api: AcpSettingsApi): Promise<AcpAgentConfig[]> {
  return parseAcpAgentConfigs(await api.settings.get('registeredAcpAgents'))
}

/**
 * The selector groups for a picker value, or `[]` when it is not an ACP agent
 * (or the agent has never been probed). Called on every picker open, so it only
 * reads cached settings — probing spawns the agent and stays a settings action.
 */
export async function loadAcpOptionGroups(
  api: AcpSettingsApi,
  model: string,
): Promise<{ agentId: string; groups: AcpOptionGroup[] } | null> {
  const selection = parseAcpModelSelection(model)
  if (!selection) return null
  const agent = (await readAgents(api)).find((candidate) => candidate.id === selection.id)
  if (!agent?.enabled) return null
  const groups = acpOptionGroupsFor(agent)
  return groups.length > 0 ? { agentId: agent.id, groups } : null
}

/**
 * Persist one selection onto the agent config. Config options are stored by
 * `configId` and applied live via `session/set_config_option`; a session mode
 * lands on `permissionMode` and takes effect on the next session (it is part of
 * the pool fingerprint). Settings are re-read immediately before the write so a
 * concurrent edit elsewhere is not clobbered.
 */
export async function saveAcpOptionSelection(
  api: AcpSettingsApi,
  agentId: string,
  group: Pick<AcpOptionGroup, 'id' | 'kind'>,
  value: string,
): Promise<void> {
  const agents = await readAgents(api)
  const next = agents.map((agent) => {
    if (agent.id !== agentId) return agent
    if (group.kind === 'mode') return { ...agent, permissionMode: value }
    return { ...agent, configOptions: { ...agent.configOptions, [group.id]: value } }
  })
  await api.settings.set('registeredAcpAgents', next)
}
