/**
 * The ACP agents an unattended container can run, and why the others cannot
 * (`docs/plans/thread-in-container.md`, decisions A4 and A6).
 *
 * An agent runs in the guest only when two things hold: its binary is baked
 * into the worker image, pinned here so the image fingerprint moves with it,
 * and it has a documented API-key path — the one credential the run is given,
 * by value, scoped to the run. The user's desktop login never enters the
 * container, so an agent whose only sign-in is a browser (`cursor-agent`) stays
 * unavailable with a reason that says so, rather than the generic line that
 * sent people off to log in again.
 *
 * Pure data with no imports beyond the catalogue, so the renderer's roster and
 * the main process's resolver read the same table and give the same reasons.
 */
import { canonicalAcpAgentId, findAcpCatalogEntry } from './acp-known-agents.ts'

export interface ContainerAcpAgent {
  /** Canonical catalogue id; the model value is `acp:<id>`. */
  id: string
  /**
   * Other configured ids this entry serves: a retired adapter whose current
   * package is this one. Such a config runs under this entry's binary.
   */
  aliases?: readonly string[]
  /** npm package baked into the worker image, at exactly this version. */
  npmPackage: string
  version: string
  /** The variable the agent reads its key from; the only entry in its env. */
  keyEnv: string
  /** Copse's key slug the run takes the value from (`resolveApiKey`). */
  keySlug: string
  /** How Settings names that key, for a reason the user can act on. */
  keyLabel: string
}

export const CONTAINER_ACP_AGENTS: readonly ContainerAcpAgent[] = [
  {
    id: 'claude-acp',
    // Zed's adapter was renamed upstream to this package; a config that still
    // names it runs under the current binary.
    aliases: ['claude-code-acp'],
    npmPackage: '@agentclientprotocol/claude-agent-acp',
    version: '0.75.1',
    keyEnv: 'ANTHROPIC_API_KEY',
    keySlug: 'anthropic',
    keyLabel: 'Anthropic',
  },
  {
    id: 'codex-acp',
    npmPackage: '@agentclientprotocol/codex-acp',
    version: '1.10.0',
    // Codex accepts a platform key under this name; the OpenAI key in Settings
    // is that key. OPENAI_API_KEY is scrubbed from every agent env by design.
    keyEnv: 'CODEX_API_KEY',
    keySlug: 'openai',
    keyLabel: 'OpenAI',
  },
  {
    id: 'gemini',
    npmPackage: '@google/gemini-cli',
    version: '0.58.0',
    keyEnv: 'GEMINI_API_KEY',
    keySlug: 'gemini',
    keyLabel: 'Gemini',
  },
]

/** The key-capable entry for an agent id (any spelling the catalogue knows), or null. */
export function containerAcpAgent(agentId: string): ContainerAcpAgent | null {
  const id = canonicalAcpAgentId(agentId)
  return (
    CONTAINER_ACP_AGENTS.find((agent) => agent.id === id || agent.aliases?.includes(id)) ?? null
  )
}

/** `package@version` for each baked agent, in table order — the image's build argument. */
export function containerAcpAgentSpecs(): string[] {
  return CONTAINER_ACP_AGENTS.map((agent) => `${agent.npmPackage}@${agent.version}`)
}

export interface ContainerAcpAvailability {
  runnable: boolean
  /**
   * Short enough for a picker row suffix, specific enough to act on. `null`
   * when runnable.
   */
  reason: string | null
}

/**
 * Whether `acp:<agentId>` can run in a container given which provider keys
 * are configured (`keysConfigured[slug]`), with the per-agent reason when not.
 */
export function containerAcpAvailability(
  agentId: string,
  keysConfigured: Readonly<Record<string, boolean>>,
): ContainerAcpAvailability {
  const capable = containerAcpAgent(agentId)
  if (capable) {
    return keysConfigured[capable.keySlug] === true
      ? { runnable: true, reason: null }
      : { runnable: false, reason: `needs ${aOrAn(capable.keyLabel)} API key in Settings` }
  }
  const known = findAcpCatalogEntry(agentId)
  if (known?.setup && !known.envHints?.length) {
    return { runnable: false, reason: 'signs in through a browser; no API-key path' }
  }
  return { runnable: false, reason: 'not carried by the worker image' }
}

/** Human names of the agents the guest can run, for a sentence in the dialog. */
export function containerAcpAgentTitles(): string[] {
  return CONTAINER_ACP_AGENTS.map((agent) => findAcpCatalogEntry(agent.id)?.title ?? agent.id)
}

function aOrAn(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
}
