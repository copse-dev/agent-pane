import type { AcpAgentConfig, AcpAuthState } from '@shared/types/acp.ts'
import {
  acpReauthCommand,
  type DetectedAcpAgent,
  type KnownAcpAgent,
} from '@shared/acp-known-agents.ts'
import { el } from '../../dom/helpers.ts'
import { AGENT_LOGO_SVG } from './agent-logos.ts'

// Coding-agent rows for the Models & agents list in Settings
// (models-agents-list.ts): one row per agent that is on this device (or already
// added), with a connection/sign-in chip beside its name. Agents that are not
// installed live behind "+ Add".

export type AgentChip = 'ready' | 'needs-sign-in' | 'unverified'

export interface AgentRowModel {
  id: string
  title: string
  chip: AgentChip
  /** Recovery remains available until a session probe succeeds. */
  signInCommand: string | null
}

/** What a row shows, from the device scan and the agent's own sign-in check. */
export function agentChip(auth: AcpAuthState | undefined, verified = false): AgentChip {
  if (auth === 'signed-out') return 'needs-sign-in'
  // Local credentials and CLI status do not establish a working connection.
  return verified ? 'ready' : 'unverified'
}

/**
 * Rows to list: known agents that are installed or already added, then any
 * custom agents the user added. Not-installed known agents go in the Add menu.
 */
export function listedAgents(
  known: readonly KnownAcpAgent[],
  detected: ReadonlyMap<string, DetectedAcpAgent>,
  configured: readonly AcpAgentConfig[],
  auth: ReadonlyMap<string, AcpAuthState>,
  verified: ReadonlySet<string> = new Set(),
): AgentRowModel[] {
  const configuredIds = new Set(configured.map((a) => a.id))
  const rows: AgentRowModel[] = []
  for (const k of known) {
    if (!configuredIds.has(k.id) && !detected.get(k.id)?.installed) continue
    const chip = agentChip(auth.get(k.id), verified.has(k.id))
    rows.push({
      id: k.id,
      title: k.title,
      chip,
      signInCommand: chip !== 'ready' ? acpReauthCommand(k) : null,
    })
  }
  const knownIds = new Set(known.map((k) => k.id))
  for (const a of configured) {
    if (knownIds.has(a.id)) continue
    rows.push({
      id: a.id,
      title: a.title,
      chip: agentChip(auth.get(a.id), verified.has(a.id)),
      signInCommand: null,
    })
  }
  return rows
}

/** Known agents that are neither installed nor added: the "+ Add an agent" menu. */
export function addableAgents(
  known: readonly KnownAcpAgent[],
  detected: ReadonlyMap<string, DetectedAcpAgent>,
  configured: readonly AcpAgentConfig[],
): KnownAcpAgent[] {
  const configuredIds = new Set(configured.map((a) => a.id))
  return known.filter((k) => !configuredIds.has(k.id) && !detected.get(k.id)?.installed)
}

const LOGO_KEY: Readonly<Record<string, string>> = {
  'claude-acp': 'claude',
  'claude-code-acp': 'claude',
  'codex-acp': 'codex',
  gemini: 'gemini',
  cursor: 'cursor',
}

/** Brand tile for an agent; a letter tile when we have no mark for it. */
export function logoTile(id: string, title: string): HTMLElement {
  const key = LOGO_KEY[id]
  const svg = key ? AGENT_LOGO_SVG[key] : undefined
  const tile = el('span', { class: 'acp-logo', 'aria-hidden': 'true' })
  if (key) tile.dataset['brand'] = key
  if (!svg) {
    tile.textContent = title.slice(0, 1).toUpperCase()
    return tile
  }
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  tile.append(document.importNode(doc.documentElement, true))
  return tile
}
