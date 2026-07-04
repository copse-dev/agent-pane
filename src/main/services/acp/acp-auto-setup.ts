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
}

export interface AcpAutoSetupPlan {
  /** Presets whose npm package should be installed (client present, adapter missing). */
  install: KnownAcpAgent[]
  /** Presets to register now (binary available or about to be installed). */
  register: KnownAcpAgent[]
}

/** Decide, from detection facts, what to install and what to register. Pure. */
export function planAcpAutoSetup(inputs: readonly AcpAutoSetupInput[]): AcpAutoSetupPlan {
  const install: KnownAcpAgent[] = []
  const register: KnownAcpAgent[] = []
  for (const { known, agentInstalled, clientInstalled, configured } of inputs) {
    if (!known.preset) continue
    const willInstall = Boolean(
      known.autoInstall && known.installPackage && clientInstalled && !agentInstalled,
    )
    if (willInstall) install.push(known)
    // Register once the binary is (or is about to be) available and not already configured.
    if (!configured && (agentInstalled || willInstall)) register.push(known)
  }
  return { install, register }
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
  const configured = new Set(listAcpAgents().map((agent) => agent.id))
  const presets = KNOWN_ACP_AGENTS.filter((known) => known.preset)

  const inputs: AcpAutoSetupInput[] = await Promise.all(
    presets.map(async (known) => ({
      known,
      agentInstalled: (await resolveOnPath(known.command)) !== null,
      clientInstalled: known.requiresClient
        ? (await resolveOnPath(known.requiresClient)) !== null
        : true,
      configured: configured.has(known.id),
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
    if (cwd) {
      try {
        const selector = await listAcpAgentModels({
          command: known.command,
          cwd,
          ...(known.args.length ? { args: known.args } : {}),
          ...(known.sandbox ? { sandbox: known.sandbox } : {}),
        })
        if (selector?.choices.length) {
          config = { ...config, availableModels: selector.choices }
          result.modelsDetected.push(known.id)
        }
      } catch {
        // Model probe is best-effort (auth/network/timeout); the agent is still
        // registered and the user can hit "Detect models" later.
      }
    }
    await upsertAcpAgent(config)
    result.registered.push(known.id)
  }

  return result
}
