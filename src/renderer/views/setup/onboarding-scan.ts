// The onboarding machine scan: one automatic read-only sweep over local model
// servers, LM Studio and installed ACP agents, plus the import step that acts on
// whatever the user left ticked. Environment and shell-file API keys are added
// separately after explicit consent in the dialog. Kept apart so probe
// aggregation, consent-before-import ordering and defaults are unit-testable.

import type { ApiClient, DetectedEnvKey, DetectedAcpAgent } from '../../../preload/api.d.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { parseAcpAgentConfigs } from '@shared/acp.ts'
import {
  BALANCED_MODEL_SELECTOR,
  BEST_LOCAL_MODEL_SELECTOR,
  CHEAPEST_MODEL_SELECTOR,
  minIntellectSelector,
} from '@copse/llm/dynamic-model.ts'
import {
  detectLocalServers,
  importDetectedPreset,
  type LocalServerResult,
} from './local-detection.ts'
import { knownToConfig, upsertAgent } from './acp-agents-section.ts'

export type ScanProbe = 'local-servers' | 'acp-agents' | 'lm-studio'

export interface LmStudioFinding {
  installed: boolean
  serverUrl: string
  running: boolean
  models: string[]
}

export interface ScanFindings {
  /** Masked previews of provider keys found in env/shell files. */
  envKeys: DetectedEnvKey[]
  /** Built-in local presets (Ollama, Jan, …); LM Studio is reported separately. */
  localServers: LocalServerResult[]
  /** Known ACP agents resolved on PATH. */
  acpAgents: DetectedAcpAgent[]
  /** LM Studio via its dedicated detect (honours the stored localServerUrl). */
  lmStudio: LmStudioFinding | null
  /** Probes that failed; the others still report. */
  errors: { probe: ScanProbe; message: string }[]
}

/** What the user left ticked in the results list. */
export interface ScanSelection {
  /** Provider slugs of env keys to import. */
  envKeyProviders: string[]
  /** Preset slugs of reachable local servers to import models for. */
  localServerIds: string[]
  /** Ids of installed ACP agents to register (config only, no installs). */
  acpAgentIds: string[]
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'probe failed'
}

/**
 * Run every non-sensitive probe concurrently; a failed probe contributes an
 * `errors` entry and an empty result rather than sinking the scan. Shell startup
 * files are deliberately excluded: the onboarding dialog only calls
 * `settings.scanEnvKeys()` after the user explicitly chooses that scan.
 */
export async function runOnboardingScan(api: ApiClient): Promise<ScanFindings> {
  const [localServers, acpAgents, lmStudio] = await Promise.allSettled([
    detectLocalServers(api),
    api.acp.detectAgents(),
    api.lmStudio.detect(),
  ])
  const errors: ScanFindings['errors'] = []
  const take = <T>(result: PromiseSettledResult<T>, probe: ScanProbe, empty: T): T => {
    if (result.status === 'fulfilled') return result.value
    errors.push({ probe, message: message(result.reason) })
    return empty
  }
  const lm = take(
    lmStudio,
    'lm-studio',
    null as Awaited<ReturnType<ApiClient['lmStudio']['detect']>> | null,
  )
  return {
    envKeys: [],
    // LM Studio has its own detect above; the fixed-URL probe row would be a
    // duplicate (and importDetectedPreset skips it anyway).
    localServers: take(localServers, 'local-servers', [] as LocalServerResult[]).filter(
      (server) => server.id !== 'lmstudio',
    ),
    acpAgents: take(acpAgents, 'acp-agents', []),
    lmStudio: lm
      ? {
          installed: lm.installDetected,
          serverUrl: lm.serverUrl,
          running: lm.serverRunning,
          models: lm.models,
        }
      : null,
    errors,
  }
}

/**
 * Whether the scan found a usable model source: an importable cloud key or a
 * running local server. Installed ACP agents alone don't count — with nothing
 * else set up the user still needs a provider, so they get the full providers
 * screen (agents are addable there too).
 */
export function hasUsableFindings(findings: ScanFindings): boolean {
  if (findings.envKeys.some((key) => !key.alreadyConfigured)) return true
  if (findings.localServers.some((server) => server.reachable)) return true
  return findings.lmStudio?.running === true
}

/**
 * Import everything still selected. Ordering matters twice: preset imports run
 * SEQUENTIALLY (each is a read-modify-write of the single `extraProviders`
 * setting — concurrent imports would clobber each other), and the consent flag
 * is written BEFORE `importEnvKeys` (the IPC is gated on it). ACP agents are
 * recorded as config only — auto-setup (which can install adapter packages)
 * deliberately never runs here; installs wait for first use.
 *
 * Failures are collected per phase so one failed import doesn't abandon the
 * rest; callers surface them without blocking completion.
 */
export async function importScanFindings(
  api: ApiClient,
  findings: ScanFindings,
  selection: ScanSelection,
): Promise<{ errors: string[] }> {
  const errors: string[] = []

  const selectedServers = new Set(selection.localServerIds)
  for (const server of findings.localServers) {
    if (!server.reachable || !selectedServers.has(server.id)) continue
    try {
      await importDetectedPreset(api, server)
    } catch (err) {
      errors.push(`Could not save ${server.label}: ${message(err)}`)
    }
  }

  if (selection.envKeyProviders.length > 0) {
    try {
      // Ticking keys and clicking finish is the explicit opt-in; record it so
      // the gated import IPC will run.
      await api.settings.set('envKeyAutoDetectEnabled', true)
      await api.settings.importEnvKeys(selection.envKeyProviders)
    } catch (err) {
      errors.push(`Could not import API keys: ${message(err)}`)
    }
  }

  if (selection.acpAgentIds.length > 0) {
    try {
      const selectedAgents = new Set(selection.acpAgentIds)
      let agents: AcpAgentConfig[] = parseAcpAgentConfigs(
        await api.settings.get('registeredAcpAgents'),
      )
      for (const agent of findings.acpAgents) {
        if (!agent.installed || !selectedAgents.has(agent.id)) continue
        agents = upsertAgent(agents, knownToConfig(agent))
      }
      await api.settings.set('registeredAcpAgents', agents)
    } catch (err) {
      errors.push(`Could not register agents: ${message(err)}`)
    }
  }

  return { errors }
}

/**
 * Defaults written when onboarding finishes, derived from what was actually
 * imported. Every model value is a relative `auto:` selector — never a fixed
 * model id — so the choice keeps meaning "the right model for this machine"
 * as servers, keys, and the model landscape change.
 */
export interface OnboardingDefaults {
  model: string
  localDefaultModel: string
  smallTasksModel: string
  subagentModel: string
  localSubagentsEnabled: boolean
  localTodoItemsEnabled: boolean
}

export function deriveDefaultSettings(
  findings: ScanFindings,
  selection: ScanSelection,
): OnboardingDefaults {
  const selectedServers = new Set(selection.localServerIds)
  const hasLocal =
    findings.lmStudio?.running === true ||
    findings.localServers.some((server) => server.reachable && selectedServers.has(server.id))
  return {
    // Chat default is the plan/price trade-off rule, local or not.
    model: BALANCED_MODEL_SELECTOR,
    // Resolves lazily to the best model loaded on this device, so it is the
    // right value even before any server appears.
    localDefaultModel: BEST_LOCAL_MODEL_SELECTOR,
    smallTasksModel: hasLocal ? BEST_LOCAL_MODEL_SELECTOR : CHEAPEST_MODEL_SELECTOR,
    subagentModel: hasLocal ? BEST_LOCAL_MODEL_SELECTOR : minIntellectSelector(30),
    localSubagentsEnabled: hasLocal,
    localTodoItemsEnabled: hasLocal,
  }
}
