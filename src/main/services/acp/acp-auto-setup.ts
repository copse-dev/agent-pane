import { canonicalAcpAgentId } from '@shared/acp-known-agents.ts'
import { KNOWN_ACP_AGENTS, type KnownAcpAgent } from '@shared/acp-known-agents.ts'
import type { AcpAgentConfig, AcpAgentProbe, AcpAutoSetupResult } from '@shared/types/acp.ts'
import { probeAcpAgentIsolated } from './acp-probe-host.ts'
import { listAcpAgents, upsertAcpAgent } from './acp-agent-registry.ts'
import { probeAcpAgentForSettings } from './acp-agent-service.ts'
import { resolveOnPath } from './acp-detect.ts'
import {
  detectOutdatedNpmAdapter,
  npmBinBesideBinary,
  type AcpAdapterOutdated,
} from './acp-adapter-version.ts'
import { installGlobalNpmPackage, isSocketFirewallAvailable } from '../security/socket-firewall.ts'
import { getActiveProjectRoot, getWorkspaceRoot } from '../workspace.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { requestApproval } from '../approval.ts'

/**
 * "Just works" setup for curated ACP presets. It runs both when ACP settings
 * opens and on every `workspace:set`, so a preset already on PATH is usable
 * from the model picker without a Settings visit. Fresh host-wide package
 * installations are still gated by an explicit approval.
 * For each preset it:
 *
 *  1. Detects the agent binary and any gating client (`claude`, `cursor-agent`).
 *  2. Installs a missing npm adapter through Socket Firewall when the adapter opts
 *     in (`autoInstall`) and its client prerequisite is present. Script-installed
 *     binaries (Cursor) are never auto-installed; the UI shows their command.
 *  3. Updates an installed autoInstall adapter when it is behind the registry
 *     latest (same Socket-Firewall path; uses the npm beside the resolved
 *     binary so nvm prefixes stay consistent).
 *  4. Registers a ready-to-use config for any preset whose binary is available.
 *  5. Best-effort detects + caches the agent's models (needs an open folder), so
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
  /**
   * Installed npm package is older than the registry latest. Absent/null when the
   * agent isn't installed, isn't an npm autoInstall package, or the version check
   * failed (offline) — never prompts an upgrade in those cases.
   */
  outdated?: AcpAdapterOutdated | null
}

export interface AcpAutoSetupUpgrade {
  known: KnownAcpAgent
  installedVersion: string
  latestVersion: string
}

export interface AcpAutoSetupPlan {
  /** Presets whose npm package should be installed (client present, adapter missing). */
  install: KnownAcpAgent[]
  /** Presets whose installed npm adapter is behind the registry latest. */
  upgrade: AcpAutoSetupUpgrade[]
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

/** Decide, from detection facts, what to install, upgrade, register, and re-probe. Pure. */
export function planAcpAutoSetup(inputs: readonly AcpAutoSetupInput[]): AcpAutoSetupPlan {
  const install: KnownAcpAgent[] = []
  const upgrade: AcpAutoSetupUpgrade[] = []
  const register: KnownAcpAgent[] = []
  const refreshModels: KnownAcpAgent[] = []
  for (const {
    known,
    agentInstalled,
    clientInstalled,
    configured,
    hasModels,
    outdated,
  } of inputs) {
    if (!known.preset) continue
    const willInstall = Boolean(
      known.autoInstall && known.installPackage && clientInstalled && !agentInstalled,
    )
    const willUpgrade = Boolean(
      known.autoInstall &&
      known.installPackage &&
      clientInstalled &&
      agentInstalled &&
      outdated &&
      !willInstall,
    )
    if (willInstall) install.push(known)
    if (willUpgrade && outdated) {
      upgrade.push({
        known,
        installedVersion: outdated.installedVersion,
        latestVersion: outdated.latestVersion,
      })
    }
    if (!configured && (agentInstalled || willInstall)) {
      // Register once the binary is (or is about to be) available and not already configured.
      register.push(known)
    } else if (configured && !hasModels && agentInstalled) {
      // Already registered but still modelless — retry the probe now the binary is present.
      refreshModels.push(known)
    }
  }
  return { install, upgrade, register, refreshModels }
}

export type { AcpAutoSetupResult }

/** One global npm change (fresh install or upgrade of a catalog package). */
export interface AcpPackageChange {
  agent: KnownAcpAgent
  action: 'install' | 'upgrade'
  fromVersion?: string
  toVersion?: string
}

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
  // `agentId` reaches here from probes and thread model values, either of
  // which may name the agent by an id it has since outgrown.
  const canonical = canonicalAcpAgentId(agentId)
  const config = listAcpAgents().find((agent) => agent.id === canonical)
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

const noopAutoSetupResult: AcpAutoSetupResult = {
  installed: [],
  upgraded: [],
  registered: [],
  modelsDetected: [],
  failed: [],
}

/**
 * Run auto-setup, coalescing concurrent calls (e.g. the settings tab opened
 * twice, or a workspace switch racing it). A no-op on SSH workspaces:
 * `resolveOnPath` only ever sees the local main-process host PATH, and ACP
 * agents are not spawned on SSH remotes, so there is nothing to detect.
 */
export function runAcpAutoSetup(signal: AbortSignal): Promise<AcpAutoSetupResult> {
  if (isActiveSshWorkspace()) return Promise.resolve(noopAutoSetupResult)
  inFlight ??= performAcpAutoSetup(signal).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function detectPresetInputs(signal: AbortSignal): Promise<AcpAutoSetupInput[]> {
  const existing = new Map(listAcpAgents().map((agent) => [agent.id, agent]))
  const presets = KNOWN_ACP_AGENTS.filter((known) => known.preset)
  return Promise.all(
    presets.map(async (known) => {
      const agentPath = await resolveOnPath(known.command)
      const agentInstalled = agentPath !== null
      const clientInstalled = known.requiresClient
        ? (await resolveOnPath(known.requiresClient)) !== null
        : true
      let outdated: AcpAdapterOutdated | null = null
      if (
        agentPath &&
        known.autoInstall &&
        known.installPackage &&
        clientInstalled &&
        !signal.aborted
      ) {
        outdated = await detectOutdatedNpmAdapter(agentPath, known.installPackage, signal)
      }
      return {
        known,
        agentInstalled,
        clientInstalled,
        configured: existing.has(known.id),
        hasModels: (existing.get(known.id)?.availableModels?.length ?? 0) > 0,
        outdated,
      }
    }),
  )
}

async function performAcpAutoSetup(signal: AbortSignal): Promise<AcpAutoSetupResult> {
  const result: AcpAutoSetupResult = {
    installed: [],
    upgraded: [],
    registered: [],
    modelsDetected: [],
    failed: [],
  }
  const inputs = await detectPresetInputs(signal)
  const plan = planAcpAutoSetup(inputs)
  const packageChanges = packageChangesFromPlan(plan)

  const packageResult = await installAcpPackageChanges(packageChanges, signal)
  result.installed.push(...packageResult.installed)
  result.upgraded.push(...packageResult.upgraded)
  result.failed.push(...packageResult.failed)
  const installedNow = new Set(result.installed)
  const upgradedNow = new Set(result.upgraded)

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
  // models (installed/authenticated since). Also re-probe after a successful
  // upgrade so models the newer adapter advertises reach the picker.
  const refreshAfterUpgrade = plan.upgrade
    .map((entry) => entry.known)
    .filter(
      (known) =>
        upgradedNow.has(known.id) &&
        inputs.some((input) => input.known.id === known.id && input.configured),
    )
  const refreshSeen = new Set<string>()
  for (const known of [...plan.refreshModels, ...refreshAfterUpgrade]) {
    if (signal.aborted || refreshSeen.has(known.id)) continue
    refreshSeen.add(known.id)
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

/** Apply catalog package changes only after consent for any fresh global install. */
export async function installAcpPackageChanges(
  packageChanges: readonly AcpPackageChange[],
  signal: AbortSignal,
  dependencies: {
    socketFirewallAvailable: typeof isSocketFirewallAvailable
    requestInstallApproval: typeof requestAcpPackageInstallApproval
    resolveNpmBin: typeof resolveNpmBinForChange
    install: typeof installGlobalNpmPackage
  } = {
    socketFirewallAvailable: isSocketFirewallAvailable,
    requestInstallApproval: requestAcpPackageInstallApproval,
    resolveNpmBin: resolveNpmBinForChange,
    install: installGlobalNpmPackage,
  },
): Promise<Pick<AcpAutoSetupResult, 'installed' | 'upgraded' | 'failed'>> {
  const result: Pick<AcpAutoSetupResult, 'installed' | 'upgraded' | 'failed'> = {
    installed: [],
    upgraded: [],
    failed: [],
  }
  const socketFirewallAvailable = dependencies.socketFirewallAvailable()
  const installApproved = await dependencies.requestInstallApproval(
    packageChanges,
    socketFirewallAvailable,
  )
  for (const change of packageChanges) {
    if (!installApproved && (change.action === 'install' || !socketFirewallAvailable)) {
      result.failed.push({
        id: change.agent.id,
        reason: socketFirewallAvailable
          ? 'package install not approved'
          : 'Socket Firewall install not approved',
      })
      continue
    }
    if (signal.aborted || !change.agent.installPackage) break
    const npmBin = await dependencies.resolveNpmBin(change)
    const ok = await dependencies.install(
      change.agent.installPackage,
      signal,
      npmBin ? { npmBin } : {},
    )
    if (ok) {
      if (change.action === 'upgrade') {
        result.upgraded.push(change.agent.id)
      } else {
        result.installed.push(change.agent.id)
      }
    } else {
      result.failed.push({
        id: change.agent.id,
        reason: change.action === 'upgrade' ? 'package upgrade failed' : 'package install failed',
      })
    }
  }
  return result
}

function packageChangesFromPlan(plan: AcpAutoSetupPlan): AcpPackageChange[] {
  const changes: AcpPackageChange[] = plan.install.map((agent) => ({
    agent,
    action: 'install' as const,
  }))
  for (const entry of plan.upgrade) {
    changes.push({
      agent: entry.known,
      action: 'upgrade',
      fromVersion: entry.installedVersion,
      toVersion: entry.latestVersion,
    })
  }
  return changes
}

async function resolveNpmBinForChange(change: AcpPackageChange): Promise<string | undefined> {
  if (change.action !== 'upgrade') return undefined
  const binaryPath = await resolveOnPath(change.agent.command)
  return binaryPath ? npmBinBesideBinary(binaryPath) : undefined
}

/** Build the approval dialog title/body for fresh global installs. Pure. */
export function formatAcpPackageApproval(
  changes: readonly AcpPackageChange[],
  socketFirewallAvailable = true,
): {
  title: string
  body: string
} {
  const installs = changes.filter((change) => change.action === 'install')
  if (!installs.length && !socketFirewallAvailable) {
    return {
      title: 'Install Socket Firewall globally?',
      body:
        'Copse needs to install Socket Firewall (sfw) globally before updating the software that connects your coding agents. ' +
        'The updates then run through Socket Firewall with lifecycle scripts disabled.',
    }
  }
  const lines = [
    'Copse needs a few small packages so it can communicate with your coding agents. They are installed globally on this computer, outside this project. Copse wants to install these npm packages:',
    '',
  ]
  for (const change of installs) {
    if (change.agent.installPackage) lines.push(`• ${change.agent.installPackage}`)
  }
  if (!socketFirewallAvailable) {
    const upgrades = changes.filter((change) => change.action === 'upgrade')
    if (upgrades.length) {
      lines.push(
        '',
        'After installing Socket Firewall, Copse will also update these installed packages:',
      )
      for (const change of upgrades) {
        if (!change.agent.installPackage) continue
        const versions =
          change.fromVersion && change.toVersion
            ? ` (${change.fromVersion} → ${change.toVersion})`
            : ''
        lines.push(`• ${change.agent.installPackage}${versions}`)
      }
    }
  }
  lines.push('')
  lines.push(
    'If Socket Firewall (sfw) is not installed, Copse will first install it globally. ' +
      'The packages are then installed through Socket Firewall with lifecycle scripts disabled.',
  )
  return { title: 'Install software to connect your coding agents?', body: lines.join('\n') }
}

/** Ask before a fresh global install, including SFW needed by an adapter update. */
export async function requestAcpPackageInstallApproval(
  changes: readonly AcpPackageChange[],
  socketFirewallAvailable = isSocketFirewallAvailable(),
): Promise<boolean> {
  if (!changes.length) return true
  if (socketFirewallAvailable && !changes.some((change) => change.action === 'install')) return true
  const { title, body } = formatAcpPackageApproval(changes, socketFirewallAvailable)
  const { approved } = await requestApproval({
    title,
    body,
    type: 'shell',
    cause: 'acp-package-setup',
    allowRemember: false,
    showWhileSettingsOpen: true,
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
  'availableModels' | 'availablePermissionModes' | 'availableConfigOptions' | 'modelsProbedAt'
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
    const probe = await probeAcpAgentIsolated({
      command: known.command,
      cwd,
      ...(known.args.length ? { args: known.args } : {}),
      ...(known.sandbox ? { sandbox: known.sandbox } : {}),
    })
    const fields: ProbedSelectorFields = {
      ...(probe.models?.choices.length ? { availableModels: probe.models.choices } : {}),
      ...(probe.modes?.choices.length ? { availablePermissionModes: probe.modes.choices } : {}),
      ...(probe.configOptions?.length ? { availableConfigOptions: probe.configOptions } : {}),
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
    ...(probe.configOptions ? { availableConfigOptions: probe.configOptions } : {}),
    modelsProbedAt: Date.now(),
  })
}
