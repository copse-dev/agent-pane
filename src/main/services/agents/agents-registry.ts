import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type {
  AgentContainer,
  AgentMetadata,
  AgentSource,
  AgentsListResult,
  ShadowedAgent,
  SkippedAgentFile,
} from '@shared/types/agents.ts'
import { pathExists, walkForContainerRoots, walkForFiles } from '../discovery/container-scan.ts'
import { parseAgentFile } from './parse-agent-frontmatter.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isWorkspaceTrusted } from '../security/workspace-trust.ts'

/**
 * Discovery for user-authored subagent definitions
 * (docs/plans/custom-subagents.md).
 *
 * Mirrors the skills registry — cache, refresh, IPC list — with one deliberate
 * divergence: **root order**. Skills put user roots first so a user skill beats
 * a project one; both Claude Code and Cursor specify project-beats-user for
 * agents, and within a scope Cursor puts its own container first. Copse's own
 * `.copse` leads for the same reason. Do not "fix" this into consistency with
 * skills.
 */

/** Containers holding an `agents/` directory, highest priority first. */
const AGENT_CONTAINERS: readonly AgentContainer[] = ['.copse', '.cursor', '.claude']

const AGENT_CONTAINER_DIRS: ReadonlySet<string> = new Set(AGENT_CONTAINERS)

export interface DiscoveryRoot {
  root: string
  source: AgentSource
  container: AgentContainer
}

let cached: AgentsListResult = { agents: [], skipped: [], shadowed: [] }
let cachedMetadata: AgentMetadata[] = []
let refreshPromise: Promise<void> | null = null
let hasCompletedRefresh = false

/** Which container a discovered root belongs to, or null if it is not one of ours. */
function containerOf(root: string): AgentContainer | null {
  const parts = root.split(sep)
  // `<…>/<container>/agents` — the container is the segment before the leaf.
  const container = parts[parts.length - 2]
  return AGENT_CONTAINERS.find((known) => known === container) ?? null
}

export async function collectDiscoveryRoots(): Promise<DiscoveryRoot[]> {
  const roots: DiscoveryRoot[] = []

  // Project scope first, and only when the workspace is trusted — a definition
  // is a system prompt plus a tool list, so a cloned repo's agents are armed by
  // the same act that arms its hooks and MCP servers, not by opening the folder.
  const workspace = getWorkspaceRoot()
  if (workspace && isWorkspaceTrusted(workspace)) {
    const found = new Set<string>()
    await walkForContainerRoots(
      workspace,
      { containerDirs: AGENT_CONTAINER_DIRS, leafName: 'agents' },
      found,
    )
    const projectRoots: Array<DiscoveryRoot & { depth: number }> = []
    for (const root of found) {
      const container = containerOf(root)
      if (!container) continue
      projectRoots.push({
        root,
        source: 'project',
        container,
        depth: root.split(sep).length,
      })
    }
    // Container priority first, then shallowest — the definition closest to the
    // workspace root wins, matching Claude Code's nested-directory rule.
    projectRoots.sort(
      (a, b) =>
        AGENT_CONTAINERS.indexOf(a.container) - AGENT_CONTAINERS.indexOf(b.container) ||
        a.depth - b.depth ||
        a.root.localeCompare(b.root),
    )
    roots.push(...projectRoots.map(({ root, source, container }) => ({ root, source, container })))
  }

  const home = homedir()
  for (const container of AGENT_CONTAINERS) {
    const root = join(home, container, 'agents')
    if (await pathExists(root)) roots.push({ root, source: 'user', container })
  }

  return roots
}

export async function discoverAgentsFromRoots(roots: readonly DiscoveryRoot[]): Promise<{
  agents: AgentMetadata[]
  skipped: SkippedAgentFile[]
  shadowed: ShadowedAgent[]
}> {
  const byName = new Map<string, AgentMetadata>()
  const skipped: SkippedAgentFile[] = []
  const shadowed: ShadowedAgent[] = []

  for (const { root, source, container } of roots) {
    await walkForFiles(
      root,
      (fileName) => fileName.toLowerCase().endsWith('.md'),
      async (agentPath) => {
        let raw: string
        try {
          raw = await fsp.readFile(agentPath, 'utf-8')
        } catch {
          return
        }

        const parsed = parseAgentFile(raw, agentPath, container)
        if (!parsed.ok) {
          // Documentation sitting in an agents directory is normal and silent;
          // a malformed definition is the thing the user needs told about.
          if (parsed.rejected.report) {
            skipped.push({ agentPath, source, reason: parsed.rejected.reason })
          }
          return
        }

        const existing = byName.get(parsed.agent.name)
        if (existing) {
          // First writer wins, and the loser gets a Settings row rather than a
          // console warning nobody reads: with three containers across two
          // scopes, a user who syncs definitions between tools hits this often.
          shadowed.push({
            name: parsed.agent.name,
            agentPath,
            source,
            shadowedBy: existing.agentPath,
          })
          return
        }

        byName.set(parsed.agent.name, {
          ...parsed.agent,
          source,
          container,
          agentPath,
        })
      },
    )
  }

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skipped,
    shadowed,
  }
}

export async function refreshAgentsRegistry(): Promise<void> {
  const { agents, skipped, shadowed } = await discoverAgentsFromRoots(await collectDiscoveryRoots())
  cachedMetadata = agents
  cached = {
    agents: agents.map(
      ({ name, description, source, container, agentPath, unsupportedFields }) => ({
        name,
        description,
        source,
        container,
        agentPath,
        unsupportedFields,
      }),
    ),
    skipped,
    shadowed,
  }
  hasCompletedRefresh = true
}

export async function initAgentsRegistry(): Promise<void> {
  if (refreshPromise) await refreshPromise
  refreshPromise = refreshAgentsRegistry()
  try {
    await refreshPromise
  } finally {
    refreshPromise = null
  }
}

/** Everything discovered, including what was skipped and shadowed (Settings). */
export function listAgents(): AgentsListResult {
  return cached
}

/** Wait for initial discovery before serving a renderer catalog read. */
export async function listAgentsWhenReady(): Promise<AgentsListResult> {
  const pending = refreshPromise
  if (pending) {
    await pending
  } else if (!hasCompletedRefresh) {
    await initAgentsRegistry()
  }
  return listAgents()
}

/** Test helper — restore the cold-start state used by the first IPC read. */
export function resetAgentsRegistryForTest(): void {
  cached = { agents: [], skipped: [], shadowed: [] }
  cachedMetadata = []
  hasCompletedRefresh = false
  refreshPromise = null
}

/** One agent's full definition, including its system-prompt body. */
export function getAgent(name: string): AgentMetadata | null {
  return cachedMetadata.find((agent) => agent.name === name) ?? null
}
