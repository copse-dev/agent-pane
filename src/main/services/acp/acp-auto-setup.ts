import { KNOWN_ACP_AGENTS, type KnownAcpAgent } from '@shared/acp-known-agents.ts'
import type { AcpAgentConfig, AcpAutoSetupResult } from '@shared/types/acp.ts'
import { listAcpAgentModels } from './acp-client.ts'
import { listAcpAgents, upsertAcpAgent } from './acp-agent-registry.ts'
import { resolveOnPath } from './acp-detect.ts'
import { installGlobalNpmPackage } from '../security/socket-firewall.ts'
import { getActiveProjectRoot, getWorkspaceRoot } from '../workspace.ts'

/**
 * One-shot "just works" setup for the curated ACP presets (Claude, Cursor),
 * run when the ACP settings tab opens. For each preset it:
 *
 *  1. Detects the agent binary and its gating client (`claude`, `cursor-agent`).
 *  2. Installs a missing npm adapter through Socket Firewall — but only when its
 *     client is present and the adapter opts in (`autoInstall`). Script-installed
 *     binaries (Cursor) are never auto-installed; the UI shows their command.
 *  3. Registers a ready-to-use config for any preset whose binary is available.
 *  4. Best-effort detects + caches the agent's models (needs an open folder), so
 *     they appear in the picker without a manual "Detect".
 *
 * The planning half is a pure function so the install/register decisions are unit
 * tested without spawning anything.
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

async function performAcpAutoSetup(signal: AbortSignal): Promise<AcpAutoSetupResult> {
  const result: AcpAutoSetupResult = {
    installed: [],
    registered: [],
    modelsDetected: [],
    failed: [],
  }
  const existing = new Map(listAcpAgents().map((agent) => [agent.id, agent]))
  const presets = KNOWN_ACP_AGENTS.filter((known) => known.preset)

  const inputs: AcpAutoSetupInput[] = await Promise.all(
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
  const plan = planAcpAutoSetup(inputs)

  const installedNow = new Set<string>()
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

  const cwd = getActiveProjectRoot() ?? getWorkspaceRoot()
  for (const known of plan.register) {
    if (signal.aborted) break
    const input = inputs.find((candidate) => candidate.known.id === known.id)
    // Skip presets we meant to install but couldn't — there's no binary to run.
    if (!input?.agentInstalled && !installedNow.has(known.id)) continue

    let config = presetToConfig(known)
    const models = await probeModels(known, cwd)
    if (models) {
      config = { ...config, availableModels: models }
      result.modelsDetected.push(known.id)
    }
    await upsertAcpAgent(config)
    result.registered.push(known.id)
  }

  // Retry model detection for agents registered on an earlier run without models
  // (installed/authenticated since). Preserves the user's config; only fills in
  // availableModels once the probe finally succeeds.
  for (const known of plan.refreshModels) {
    if (signal.aborted) break
    const config = existing.get(known.id)
    if (!config) continue
    const models = await probeModels(known, cwd)
    if (models) {
      await upsertAcpAgent({ ...config, availableModels: models })
      result.modelsDetected.push(known.id)
    }
  }

  return result
}

/**
 * Best-effort probe of a known agent's model selector. Returns the flattened
 * choices, or null when there's no open folder or the probe fails (auth, network,
 * timeout) — callers keep the agent registered and the user can "Detect models".
 */
async function probeModels(
  known: KnownAcpAgent,
  cwd: string | null,
): Promise<AcpAgentConfig['availableModels'] | null> {
  if (!cwd) return null
  try {
    const selector = await listAcpAgentModels({
      command: known.command,
      cwd,
      ...(known.args.length ? { args: known.args } : {}),
      ...(known.sandbox ? { sandbox: known.sandbox } : {}),
    })
    return selector?.choices.length ? selector.choices : null
  } catch {
    return null
  }
}
