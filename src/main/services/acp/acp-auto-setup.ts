import { KNOWN_ACP_AGENTS, type KnownAcpAgent } from '@shared/acp-known-agents.ts'
import type { AcpAgentConfig, AcpAgentProbe, AcpAutoSetupResult } from '@shared/types/acp.ts'
import { probeAcpAgent } from './acp-client.ts'
import { listAcpAgents, upsertAcpAgent } from './acp-agent-registry.ts'
import { probeAcpAgentForSettings } from './acp-agent-service.ts'
import { resolveOnPath } from './acp-detect.ts'
import { installGlobalNpmPackage } from '../security/socket-firewall.ts'
import { getActiveProjectRoot, getWorkspaceRoot } from '../workspace.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { requestApproval } from '../approval.ts'

/**
 * "Just works" setup for curated ACP presets. It runs when ACP settings opens.
 * Any host-wide package installation is still gated by an explicit approval.
 * For each preset it:
 *
 *  1. Detects the agent binary and any gating client (`claude`, `cursor-agent`).
 *  2. Installs a missing npm adapter through Socket Firewall when the adapter opts
 *     in (`autoInstall`) and its client prerequisite is present. Script-installed
 *     binaries (Cursor) are never auto-installed; the UI shows their command.
 *  3. Registers a ready-to-use config for any preset whose binary is available.
 *  4. Best-effort detects + caches the agent's models (needs an open folder), so
 *     they appear in the picker without a manual "Detect".
 *
 * The planning half is a pure function so the install/register/update decisions
 * are unit tested without spawning anything.
 */

export interface AcpAutoSetupInput {
  known: KnownAcpAgent
  /** The agent's own `command` resolves on PATH. */
  agentInstalled: boolean
  /** The gating `requiresClient` resolves on PATH (or true when there is no gate). */
  clientInstalled: boolean
  /** An agent with this id is already in `registeredAcpAgents`. */
  configured: boolean
  /** The already-configured agent has a cached, non-empty `availableModels` list. */
  hasModels: boolean
}

export interface AcpAutoSetupPlan {
  /** Presets whose npm package should be installed (client present, adapter missing). */
  install: KnownAcpAgent[]
  /** Presets to register now (binary available or about to be installed). */
  register: KnownAcpAgent[]
  /**
   * Already-registered presets whose models should be (re)probed because none are
   * cached yet. First-run registration probes models too, but that probe fails
   * silently when there's no open folder or the agent isn't signed in yet; this
   * retries on later runs so models appear once the user installs + authenticates.
   */
  refreshModels: KnownAcpAgent[]
}

/** Decide, from detection facts, what to install, register, and re-probe. Pure. */
export function planAcpAutoSetup(inputs: readonly AcpAutoSetupInput[]): AcpAutoSetupPlan {
  const install: KnownAcpAgent[] = []
  const register: KnownAcpAgent[] = []
  const refreshModels: KnownAcpAgent[] = []
  for (const { known, agentInstalled, clientInstalled, configured, hasModels } of inputs) {
    if (!known.preset) continue
    const willInstall = Boolean(
      known.autoInstall && known.installPackage && clientInstalled && !agentInstalled,
    )
    if (willInstall) install.push(known)
    if (!configured && (agentInstalled || willInstall)) {
      // Register once the binary is (or is about to be) available and not already configured.
      register.push(known)
    } else if (configured && !hasModels && agentInstalled) {
      // Already registered but still modelless — retry the probe now the binary is present.
      refreshModels.push(known)
    }
  }
  return { install, register, refreshModels }
}

export type { AcpAutoSetupResult }

/** Merge detected models onto the latest persisted config, never a pre-await snapshot. */
export async function updateCurrentAcpAgentModels(
  agentId: string,
  models: NonNullable<AcpAgentConfig['availableModels']>,
): Promise<boolean> {
  return updateCurrentAcpAgentSelectors(agentId, { availableModels: models })
}

/** Merge detected selector fields onto the latest persisted config. */
async function updateCurrentAcpAgentSelectors(
  agentId: string,
  selectors: ProbedSelectorFields,
): Promise<boolean> {
  const config = listAcpAgents().find((agent) => agent.id === agentId)
  if (!config) return false
  await upsertAcpAgent({ ...config, ...selectors })
  return true
}

/**
 * Map a catalog preset to a fresh, enabled agent config. The sandbox preset is
 * deliberately NOT copied here: the catalog is its source of truth, resolved at
 * spawn time (`resolveAcpSandbox`), so catalog improvements reach every agent
 * without config migrations. The config's `sandbox` field exists only as a
 * per-agent override (custom confines, or `false` to opt out).
 */
function presetToConfig(known: KnownAcpAgent): AcpAgentConfig {
  return {
    id: known.id,
    title: known.title,
    command: known.command,
    ...(known.args.length ? { args: known.args } : {}),
    enabled: true,
  }
}

let inFlight: Promise<AcpAutoSetupResult> | null = null

/** Run auto-setup, coalescing concurrent calls (e.g. the tab opened twice). */
export function runAcpAutoSetup(signal: AbortSignal): Promise<AcpAutoSetupResult> {
  inFlight ??= performAcpAutoSetup(signal).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function detectPresetInputs(): Promise<AcpAutoSetupInput[]> {
  const existing = new Map(listAcpAgents().map((agent) => [agent.id, agent]))
  const presets = KNOWN_ACP_AGENTS.filter((known) => known.preset)
  return Promise.all(
    presets.map(async (known) => ({
      known,
      agentInstalled: (await resolveOnPath(known.command)) !== null,
      clientInstalled: known.requiresClient
        ? (await resolveOnPath(known.requiresClient)) !== null
        : true,
      configured: existing.has(known.id),
      hasModels: (existing.get(known.id)?.availableModels?.length ?? 0) > 0,
    })),
  )
}

async function performAcpAutoSetup(signal: AbortSignal): Promise<AcpAutoSetupResult> {
  const result: AcpAutoSetupResult = {
    installed: [],
    registered: [],
    modelsDetected: [],
    failed: [],
  }
  const inputs = await detectPresetInputs()
  const plan = planAcpAutoSetup(inputs)

  const installedNow = new Set<string>()
  const installApproved = await requestAcpPackageInstallApproval(plan.install)
  if (!installApproved) {
    for (const known of plan.install) {
      result.failed.push({ id: known.id, reason: 'package install not approved' })
    }
  } else {
    for (const known of plan.install) {
      if (signal.aborted || !known.installPackage) break
      const ok = await installGlobalNpmPackage(known.installPackage, signal)
      if (ok) {
        installedNow.add(known.id)
        result.installed.push(known.id)
      } else {
        result.failed.push({ id: known.id, reason: 'package install failed' })
      }
    }
  }

  const cwd = getActiveProjectRoot() ?? getWorkspaceRoot()
  for (const known of plan.register) {
    if (signal.aborted) break
    const input = inputs.find((candidate) => candidate.known.id === known.id)
    // Skip presets we meant to install but couldn't — there's no binary to run.
    if (!input?.agentInstalled && !installedNow.has(known.id)) continue

    let config = presetToConfig(known)
    const probed = await probeSelectors(known, cwd)
    if (probed.availableModels || probed.availablePermissionModes) {
      config = { ...config, ...probed }
      if (probed.availableModels) result.modelsDetected.push(known.id)
    }
    await upsertAcpAgent(config)
    result.registered.push(known.id)
  }

  // Retry selector detection for agents registered on an earlier run without
  // models (installed/authenticated since). Merge onto the latest registry
  // entry because approval, installs, and probing may outlive settings changes.
  for (const known of plan.refreshModels) {
    if (signal.aborted) break
    const probed = await probeSelectors(known, cwd)
    if (
      (probed.availableModels || probed.availablePermissionModes) &&
      (await updateCurrentAcpAgentSelectors(known.id, probed))
    ) {
      if (probed.availableModels) result.modelsDetected.push(known.id)
    }
  }

  return result
}

/** Ask before mutating the user's global npm installation. */
export async function requestAcpPackageInstallApproval(
  agents: readonly KnownAcpAgent[],
): Promise<boolean> {
  const packages = agents.flatMap((agent) => (agent.installPackage ? [agent.installPackage] : []))
  if (packages.length === 0) return true
  const { approved } = await requestApproval({
    title: 'Install ACP adapters globally?',
    body:
      'Copse found missing ACP adapters and wants to install these global npm packages:\n\n' +
      packages.map((pkg) => `• ${pkg}`).join('\n') +
      '\n\nIf Socket Firewall (sfw) is not installed, Copse will first install it globally. ' +
      'The adapter packages are then installed through Socket Firewall with lifecycle scripts disabled.',
    type: 'shell',
    allowRemember: false,
  })
  return approved
}

/**
 * Cached-selector fields (models + session modes) discovered from one probe, to
 * spread onto a registered {@link AcpAgentConfig}. Empty object when the probe
 * found neither (or failed) — callers still register the agent, and the user can
 * fill these in later with "Detect models".
 */
type ProbedSelectorFields = Pick<
  AcpAgentConfig,
  'availableModels' | 'availablePermissionModes' | 'modelsProbedAt'
>

/**
 * Best-effort probe of a known agent's models and session modes (issue #607).
 * Returns the cached-selector fields, or `{}` when there's no open folder or the
 * probe fails (auth, network, timeout) — callers keep the agent registered
 * regardless and the user can "Detect models" later.
 */
async function probeSelectors(
  known: KnownAcpAgent,
  cwd: string | null,
): Promise<ProbedSelectorFields> {
  if (!cwd) return {}
  try {
    const probe = await probeAcpAgent({
      command: known.command,
      cwd,
      ...(known.args.length ? { args: known.args } : {}),
      ...(known.sandbox ? { sandbox: known.sandbox } : {}),
    })
    const fields: ProbedSelectorFields = {
      ...(probe.models?.choices.length ? { availableModels: probe.models.choices } : {}),
      ...(probe.modes?.choices.length ? { availablePermissionModes: probe.modes.choices } : {}),
    }
    // Stamp the probe time whenever we actually reached the agent, so the
    // TTL-based background revalidation doesn't immediately re-probe an agent we
    // just detected. Only meaningful alongside availableModels (staleness is
    // keyed off a non-empty model list), but harmless when only modes came back.
    return probe.models || probe.modes ? { ...fields, modelsProbedAt: Date.now() } : fields
  } catch {
    return {}
  }
}

/** Re-probe a cached model list at most this often (24h). */
export const ACP_MODELS_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Whether an agent's cached model list should be re-probed. Pure so the decision
 * is unit-tested without spawning anything. Only agents that are enabled and
 * already have a cached list qualify (the empty-cache first-probe is handled by
 * {@link planAcpAutoSetup}'s `refreshModels`); a cache with no `modelsProbedAt`
 * (written before the field existed) counts as maximally stale.
 */
export function acpModelsCacheStale(
  agent: AcpAgentConfig,
  now: number,
  ttl: number = ACP_MODELS_TTL_MS,
): boolean {
  if (!agent.enabled) return false
  if (!agent.availableModels?.length) return false
  return now - (agent.modelsProbedAt ?? 0) >= ttl
}

/** Ids currently being revalidated, so overlapping triggers don't double-spawn. */
const revalidating = new Set<string>()

/**
 * Non-blocking, best-effort refresh of stale cached ACP model lists (issue: new
 * models like a fresh Opus release never appeared until the user re-detected).
 * For each enabled agent whose cache has aged past the TTL, re-probe it in the
 * background and REPLACE its cached `availableModels`/`availablePermissionModes`
 * wholesale — so models the agent added *or removed* since the last probe are
 * reflected on the picker's next open (the picker reads settings live). Kicked
 * off fire-and-forget from `workspace:set`; never awaited, never throws. A probe
 * that fails or surfaces no selector leaves the existing cache untouched, so a
 * transient auth/spawn hiccup can't wipe a good list.
 */
export function revalidateStaleAcpModels(now: number = Date.now()): void {
  if (isActiveSshWorkspace()) return // ACP agents are not spawned on SSH remotes
  for (const agent of listAcpAgents()) {
    if (!acpModelsCacheStale(agent, now)) continue
    if (revalidating.has(agent.id)) continue
    revalidating.add(agent.id)
    void revalidateAcpAgentModels(agent.id).finally(() => {
      revalidating.delete(agent.id)
    })
  }
}

/** Probe one agent and replace its cached selectors; keep the cache on failure. */
async function revalidateAcpAgentModels(agentId: string): Promise<void> {
  let probe: AcpAgentProbe
  try {
    probe = await probeAcpAgentForSettings(agentId)
  } catch {
    return // no open folder, SSH, or a spawn/auth failure — keep the existing cache
  }
  // A probe that surfaced no selector at all must not wipe a good cache.
  if (!probe.models && !probe.modes) return
  await updateCurrentAcpAgentSelectors(agentId, {
    ...(probe.models ? { availableModels: probe.models.choices } : {}),
    ...(probe.modes ? { availablePermissionModes: probe.modes.choices } : {}),
    modelsProbedAt: Date.now(),
  })
}
