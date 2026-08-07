// Host disk discovery for Agent Plugins — Stage A2 of
// docs/plans/agent-plugins-migration.md.
//
// Closes the gap `docs/packs.md` has carried since the pack registry landed:
// "Host disk-discovery that feeds user packs into the registry is **not wired
// yet**". The first attempt (#1342) was closed unmerged; its follow-up list is
// preserved on #1082 and is implemented here.
//
// Layout: one directory per plugin under the Copse-owned plugin root, each an
// Agent Plugins package (a root `plugin.json`, optional `skills/`, optional
// `mcp.json`).
//
//   ~/.copse/plugins/
//   ├── acme.reviewer/
//   │   ├── plugin.json
//   │   ├── skills/…
//   │   └── mcp.json
//   └── broken/            ← skipped, with a reason; neighbours still load
//
// **Four properties this module owes the follow-up list**, each pinned by a test
// in `discover-user-plugins.test.ts`:
//
//  1. *A stable root with an override.* `COPSE_PLUGINS_DIR` relocates it so
//     tests and relocation never touch a developer's real plugins.
//  2. *Per-plugin failure isolation.* One unreadable, malformed, or colliding
//     neighbour must not break startup — a missing root is inert, not an error.
//  3. *Finding bytes is not activating behavior.* Discovery produces validated
//     candidates. Registration and enablement are the caller's separate steps,
//     and a newly discovered plugin is never auto-enabled.
//  4. *No self-granted authority.* Naming an existing capability or permission
//     seam in a manifest declares an intent to request it; the registry and
//     permission-gate still decide. The parse layer additionally strips
//     native tools, ACP exposure, level-3 UI, and trusted prompt.
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  AGENT_PLUGIN_MANIFEST_FILE,
  AGENT_PLUGIN_MCP_FILE,
  AGENT_PLUGIN_SKILLS_DIR,
  AgentPluginManifestError,
  parseAgentPluginManifest,
  type AgentPluginMetadata,
} from '@copse/agent/packs/agent-plugin-manifest.ts'
import {
  AgentPluginMcpError,
  parseAgentPluginMcp,
  type AgentPluginMcpServer,
} from '@copse/agent/packs/agent-plugin-mcp.ts'
import {
  definePack,
  type PackManifest,
  type RegisteredPack,
} from '@copse/agent/packs/pack-manifest.ts'
import { safeJsonParse } from '@shared/safe-json.ts'

/** Environment override for the plugin root (tests, relocation). */
export const COPSE_PLUGINS_DIR_ENV = 'COPSE_PLUGINS_DIR'

/** Manifests larger than this are refused before parsing. */
const MAX_MANIFEST_BYTES = 1024 * 1024

/** Upper bound on directories scanned, so a stray huge folder cannot stall boot. */
const MAX_PLUGIN_DIRECTORIES = 512

/**
 * The Copse-owned plugin root. Sits beside the filesystem-native thread store
 * (`~/.copse/workspace/`) rather than under Electron's userData, so a user can
 * inspect, version, and hand-edit their plugins with ordinary tools — the same
 * reasoning the thread store already applies.
 */
export function userPluginsRoot(): string {
  const override = process.env[COPSE_PLUGINS_DIR_ENV]
  if (override && override.trim() !== '') return resolve(override)
  return join(homedir(), '.copse', 'plugins')
}

/**
 * The per-plugin writable directory Agent Plugins §9.1 requires: created before
 * a plugin subprocess launches, writable by it, and **preserved across plugin
 * updates**. Deliberately a sibling of the payload rather than a child, so
 * replacing package contents on update cannot take the data with it.
 */
export function userPluginDataDir(pluginName: string): string {
  return join(userPluginsRoot(), '.data', pluginName)
}

/** A validated plugin directory, ready for registration. */
export interface UserPluginCandidate {
  readonly pluginRoot: string
  readonly manifestPath: string
  readonly manifest: PackManifest
  readonly metadata: AgentPluginMetadata
  /** Absolute `skills/` path when the plugin ships skills (§6.1). */
  readonly skillsDir?: string
  /** Absolute `mcp.json` path when the plugin ships MCP servers (§6.1). */
  readonly mcpConfigPath?: string
  /**
   * Server entries that validated. Populated at discovery because validating a
   * declaration is not the same as running it — nothing here is spawned, and
   * wiring these into the live agent loop is separate work.
   */
  readonly mcpServers: ReadonlyMap<string, AgentPluginMcpServer>
  /** Non-fatal findings: ignored fields, stripped capabilities, skipped parts. */
  readonly warnings: readonly string[]
}

/** A directory that could not become a plugin, and why. */
export interface UserPluginFailure {
  readonly pluginRoot: string
  readonly reason: string
}

export interface UserPluginDiscovery {
  readonly root: string
  readonly plugins: readonly UserPluginCandidate[]
  readonly failures: readonly UserPluginFailure[]
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * §4.1: every package path a client reads must stay within the *filesystem
 * resolved* plugin root. The spec permits symlinks whose targets land inside the
 * root; resolving both sides with `realpath` before comparing is what makes that
 * check meaningful rather than a string prefix test.
 */
async function resolveWithinRoot(root: string, candidate: string): Promise<string | null> {
  const resolved = await fsp.realpath(candidate).catch(() => null)
  if (!resolved) return null
  const rel = relative(root, resolved)
  if (rel === '') return resolved
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return resolved
}

async function readManifestFile(manifestPath: string): Promise<unknown> {
  const stat = await fsp.stat(manifestPath)
  if (!stat.isFile()) {
    throw new Error(`${AGENT_PLUGIN_MANIFEST_FILE} is not a regular file.`)
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${AGENT_PLUGIN_MANIFEST_FILE} exceeds 1 MB.`)
  }
  const text = await fsp.readFile(manifestPath, 'utf8')
  const parsed = safeJsonParse(text)
  if (parsed === null) throw new Error(`${AGENT_PLUGIN_MANIFEST_FILE} is not valid JSON.`)
  return parsed
}

/**
 * Resolve one optional fixed component location. §6.2 draws a distinction worth
 * keeping: *absent* is not an error, but *present as the wrong filesystem kind*
 * invalidates that component type while the rest of the plugin still loads.
 */
async function resolveComponent(
  pluginRoot: string,
  name: string,
  expect: 'file' | 'directory',
  warnings: string[],
): Promise<string | undefined> {
  const candidate = join(pluginRoot, name)
  const stat = await fsp.stat(candidate).catch(() => null)
  if (!stat) return undefined
  const matches = expect === 'file' ? stat.isFile() : stat.isDirectory()
  if (!matches) {
    warnings.push(`Ignoring \`${name}\`: expected a ${expect} (Agent Plugins §6.2).`)
    return undefined
  }
  const contained = await resolveWithinRoot(pluginRoot, candidate)
  if (!contained) {
    warnings.push(`Ignoring \`${name}\`: it resolves outside the plugin root (Agent Plugins §4.1).`)
    return undefined
  }
  return contained
}

/** Load and validate one plugin directory. Throws with a reportable reason. */
export async function loadUserPlugin(pluginPath: string): Promise<UserPluginCandidate> {
  const pluginRoot = await fsp.realpath(pluginPath).catch(() => null)
  if (!pluginRoot) throw new Error('Plugin directory does not exist.')

  const manifestPath = await resolveWithinRoot(
    pluginRoot,
    join(pluginRoot, AGENT_PLUGIN_MANIFEST_FILE),
  )
  if (!manifestPath) {
    // §4.1 failure boundary 1: no resolvable root manifest, no plugin.
    throw new Error(`No ${AGENT_PLUGIN_MANIFEST_FILE} at the plugin root.`)
  }

  const raw = await readManifestFile(manifestPath)
  const parsed = parseAgentPluginManifest(raw)
  const warnings = [...parsed.warnings]

  const skillsDir = await resolveComponent(
    pluginRoot,
    AGENT_PLUGIN_SKILLS_DIR,
    'directory',
    warnings,
  )
  const mcpConfigPath = await resolveComponent(pluginRoot, AGENT_PLUGIN_MCP_FILE, 'file', warnings)
  const mcpServers = await readMcpServers(mcpConfigPath, warnings)

  return {
    pluginRoot,
    manifestPath,
    manifest: parsed.manifest,
    metadata: parsed.metadata,
    ...(skillsDir === undefined ? {} : { skillsDir }),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    mcpServers,
    warnings,
  }
}

/**
 * Read and validate `mcp.json`, if present.
 *
 * §7.2.2's failure boundaries in one place: a file-level problem disables MCP
 * for this plugin while every other component type keeps loading, and a bad
 * individual entry skips only that server. Neither rejects the plugin — a
 * package shipping skills *and* one broken server is still worth having.
 */
async function readMcpServers(
  mcpConfigPath: string | undefined,
  warnings: string[],
): Promise<ReadonlyMap<string, AgentPluginMcpServer>> {
  if (mcpConfigPath === undefined) return new Map()
  try {
    const text = await fsp.readFile(mcpConfigPath, 'utf8')
    const raw = safeJsonParse(text)
    if (raw === null) throw new AgentPluginMcpError(`${AGENT_PLUGIN_MCP_FILE} is not valid JSON.`)
    const parsed = parseAgentPluginMcp(raw)
    warnings.push(...parsed.warnings)
    return parsed.servers
  } catch (error) {
    warnings.push(`Disabling MCP for this plugin: ${describeError(error)}`)
    return new Map()
  }
}

/**
 * Walk the plugin root, returning every directory that validated plus a reason
 * for each that did not.
 *
 * A missing root is inert — the overwhelmingly common case is a user who has
 * never installed a plugin, and that must cost nothing and log nothing.
 */
export async function discoverUserPlugins(root = userPluginsRoot()): Promise<UserPluginDiscovery> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => null)
  if (!entries) return { root, plugins: [], failures: [] }

  const plugins: UserPluginCandidate[] = []
  const failures: UserPluginFailure[] = []
  const seen = new Set<string>()
  let scanned = 0

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // `.data` holds the PLUGIN_DATA directories; dotfiles are never packages.
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (scanned >= MAX_PLUGIN_DIRECTORIES) {
      failures.push({
        pluginRoot: join(root, entry.name),
        reason: `Stopped after ${String(MAX_PLUGIN_DIRECTORIES)} plugin directories.`,
      })
      break
    }
    scanned += 1

    const pluginPath = join(root, entry.name)
    try {
      const candidate = await loadUserPlugin(pluginPath)
      // A duplicate id would throw at registration and take the *first* plugin
      // down with it. Refuse the later one here, where the reason is knowable.
      if (seen.has(candidate.manifest.name)) {
        failures.push({
          pluginRoot: pluginPath,
          reason: `Duplicate plugin id ${JSON.stringify(candidate.manifest.name)}.`,
        })
        continue
      }
      seen.add(candidate.manifest.name)
      plugins.push(candidate)
    } catch (error) {
      const reason =
        error instanceof AgentPluginManifestError
          ? `${error.kind === 'copse-extension' ? 'Copse extension' : 'Agent Plugins manifest'}: ${error.message}`
          : describeError(error)
      failures.push({ pluginRoot: pluginPath, reason })
    }
  }

  return { root, plugins, failures }
}

/**
 * Project a discovered plugin into a {@link RegisteredPack}.
 *
 * Contributions stay empty: this phase gives the plugin a Settings row and a
 * lifecycle, and nothing more. Wiring its command hooks and MCP servers into the
 * live agent loop is deliberately separate work — the same split #1342 drew —
 * because discovering bytes must not be what activates behavior.
 */
export function registeredUserPlugin(candidate: UserPluginCandidate): RegisteredPack {
  return definePack({ ...candidate.manifest, trust: 'user' })
}
