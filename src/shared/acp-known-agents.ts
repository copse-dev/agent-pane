/**
 * Catalog of well-known external ACP agents Copse can drive (client role). Used
 * to (a) detect what's already installed/running on the device, (b) prefill a
 * `registeredAcpAgents` entry, and (c) show "preinstall" guidance — how to
 * install the agent binary and how to authenticate it.
 *
 * The data lives in `src/shared/data/acp-metadata.json` (see acp-metadata.ts):
 * a pinned snapshot of the public ACP registry plus Copse's hand-curated
 * overlay (spawn command, seatbelt, sign-in). This module is the merged view —
 * each KnownAcpAgent is a curated overlay entry annotated with the pinned
 * registry facts (version, description, icon, exact install spec).
 *
 * Important: the agent is a *separate program*, not bundled with Copse. Copse
 * ships only `@agentclientprotocol/sdk` (the client/protocol half); the agent
 * half (which wraps Claude/Gemini/etc. and speaks ACP over stdio) is installed
 * by the user via `install` below. Keep curated entries conservative: only ship
 * `command`/`args` we're confident launch the agent in ACP mode.
 */

import {
  ACP_CATALOG,
  acpRegistryAgent,
  pinnedNpxSpec,
  type AcpCuratedAgent,
} from './acp-metadata.ts'

/** A curated agent merged with its pinned-registry annotations. */
export interface KnownAcpAgent extends AcpCuratedAgent {
  /** Slug used as the configured agent id and the `acp:<id>` model value. */
  id: string
  /** Version the pinned registry snapshot lists for this agent. */
  registryVersion?: string | undefined
  /** Registry description, for discovery surfaces. */
  description?: string | undefined
  /** Registry icon URL (https), when published. */
  icon?: string | undefined
  /**
   * Version-pinned npm spec from the registry snapshot (npx distribution),
   * e.g. `@agentclientprotocol/claude-agent-acp@0.69.0`. What auto-setup
   * actually installs (through Socket Firewall) when {@link autoInstall} — the
   * pin means an upstream `latest` publish cannot reach users until the
   * registry sync's 7-day cooldown has passed and the new snapshot is reviewed.
   */
  installPackagePinned?: string | undefined
}

function mergeKnown(id: string, curated: AcpCuratedAgent): KnownAcpAgent {
  const registry = acpRegistryAgent(id)
  const pinned = pinnedNpxSpec(id)
  return {
    id,
    ...curated,
    ...(registry?.version !== undefined ? { registryVersion: registry.version } : {}),
    ...(registry?.description !== undefined ? { description: registry.description } : {}),
    ...(registry?.icon !== undefined ? { icon: registry.icon } : {}),
    // Only annotate a pinned spec for agents whose curated `installPackage`
    // matches the registry's npx package name — a mismatch would install
    // something other than what the overlay's command expects to spawn.
    ...(pinned !== null && curated.installPackage && pinned.startsWith(`${curated.installPackage}@`)
      ? { installPackagePinned: pinned }
      : {}),
  }
}

export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = Object.entries(ACP_CATALOG.curated).map(
  ([id, entry]) => {
    const { comment: _comment, ...curated } = entry
    return mergeKnown(id, curated)
  },
)

/**
 * Renames, old id → current id.
 *
 * Copse's agent ids are the [ACP registry](https://github.com/agentclientprotocol/registry)
 * ids, so one vocabulary describes an agent across every client that speaks the
 * protocol.
 *
 * These entries are permanent. An id is a persisted key in three places — the
 * `acp:<id>` model value on every thread spine line, the
 * `` `${agentId}:${kind}` `` remembered-permission grants, and
 * `registeredAcpAgents` — and thread history is append-only, so the oldest of
 * those can never be rewritten. Resolve through {@link canonicalAcpAgentId}
 * wherever an id arrives from storage.
 *
 * Only *renames* belong here (enforced at catalog load: a retired id may never
 * also be an alias — aliasing a withdrawn agent to whatever replaced it would
 * make old threads claim they ran something they did not).
 */
export const LEGACY_ACP_AGENT_IDS: Readonly<Record<string, string>> = ACP_CATALOG.legacyIds

/** Current id for a possibly-legacy one. Unknown ids pass through unchanged. */
export function canonicalAcpAgentId(id: string): string {
  return LEGACY_ACP_AGENT_IDS[id] ?? id
}

/**
 * Agents that were once offered and no longer are. They are deliberately NOT in
 * {@link KNOWN_ACP_AGENTS} — nothing installs, registers, or recommends them —
 * but they keep their full entry, confinement included, for three reasons:
 *
 *  1. **They must stay sandboxed.** `resolveAcpSandbox` reads the catalog at
 *     spawn time rather than copying the profile into the persisted config, so
 *     an entry that simply disappears downgrades an existing user's agent to
 *     spawning unconfined. Retiring an agent must never relax its seatbelt.
 *  2. `isClaudeAcpAgent` matches by spawn command, so a retired Claude wrapper
 *     must still be recognised as Claude or it loses its Claude-specific
 *     handling and is demoted to the API-billed path in the picker.
 *  3. Threads that ran one stay readable — history stores `acp:<id>` forever,
 *     and without a title the picker label falls back to the raw slug.
 */
export interface RetiredAcpAgent extends KnownAcpAgent {
  /** Why it went away. Shown in review and in the Settings notice. */
  reason: string
}

export const RETIRED_ACP_AGENTS: readonly RetiredAcpAgent[] = ACP_CATALOG.retired.map((entry) => {
  const { comment: _comment, id, reason, ...curated } = entry
  return { ...mergeKnown(id, curated), reason }
})

/**
 * Catalog lookup by id across both the offered and the retired sets. Every
 * resolver that reads the catalog with a **persisted** id must go through this:
 * a config written before an agent was retired still names it, and the answer
 * for "what seatbelt does this spawn under" cannot be "none, it is gone".
 */
export function findAcpCatalogEntry(id: string): KnownAcpAgent | undefined {
  const canonical = canonicalAcpAgentId(id)
  return (
    KNOWN_ACP_AGENTS.find((agent) => agent.id === canonical) ??
    RETIRED_ACP_AGENTS.find((agent) => agent.id === canonical)
  )
}

/**
 * Command that re-establishes a lapsed sign-in for a known agent, or `null` when
 * the catalog has no way to sign this agent in (a custom entry, or one that only
 * reads an API key from its environment). Prefers the dedicated {@link
 * AcpCuratedAgent.reauth} command and falls back to {@link AcpCuratedAgent.setup},
 * which is the right answer for agents whose sign-in is a single step.
 */
export function acpReauthCommand(known: KnownAcpAgent | undefined): string | null {
  return known?.reauth ?? known?.setup ?? null
}

/** A {@link KnownAcpAgent} annotated with what was found on the device. */
export interface DetectedAcpAgent extends KnownAcpAgent {
  /** The command resolves on PATH. */
  installed: boolean
  /** Absolute path the command resolves to, when installed. */
  path: string | null
  /** A process whose argv[0] is this command is currently running. */
  running: boolean
}
