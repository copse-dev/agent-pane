// Agent Plugins v1.0.0 manifest parsing — Stage A1 of
// docs/plans/agent-plugins-migration.md.
//
// Parses a root `plugin.json` written to the [Agent Plugins
// Specification](https://agent-plugins.org/specification) into Copse's internal
// {@link PackManifest}. The spec standardizes exactly two component types —
// skills and MCP servers — so every other Copse contribution kind travels under
// the `dev.copse` reverse-domain extension namespace (spec §8), which conformant
// clients must ignore *without validating*.
//
// Three pack-manifest fields have no AP equivalent and are deliberately dropped
// rather than moved (plan, "The `dev.copse` namespace mapping"):
//   - `skills`      — §6.1 fixes discovery at `skills/`; a manifest path is forbidden
//   - `tools.mcpServers` — §7.2.1 fixes MCP at root `mcp.json`
//   - `trust`       — host-assigned; a manifest never claims its own trust class
//
// **Failure boundaries are not uniform**, and the distinction is load-bearing:
//   - An unknown top-level field is reported and ignored (§5.2). So is a
//     non-object `extensions` (§8.1). Neither rejects the plugin.
//   - Any other envelope violation is fatal — the client must reject the plugin
//     and discover none of its components (§5.3, §11.3).
//   - A malformed `dev.copse` block is a *Copse-side* rejection: the file is
//     still a valid Agent Plugin, we simply decline to register it. Callers
//     surface that differently from an envelope failure, so it carries its own
//     error kind.
//
// Electron-free (execution-guidance rule 4): the host disk walk that feeds this
// a parsed object lives in `src/main/services/packs/discover-user-plugins.ts`.
import { z } from 'zod'
import type {
  PackBrowserDecl,
  PackCapabilityDecl,
  PackCommandHookDecl,
  PackManifest,
  PackModelsDecl,
  PackPermissionDecl,
  PackPromptBlock,
  PackSettingsSchema,
  PackStorageDecl,
  PackToolRuntimeDecl,
  PackToolsDecl,
  PackUiContribution,
} from './pack-manifest.ts'
import type { PanelContributionDecl } from './pack-panel.ts'

/** Fixed manifest location (§5.1). Never configurable. */
export const AGENT_PLUGIN_MANIFEST_FILE = 'plugin.json'

/** Fixed skills location (§6.1). Never configurable. */
export const AGENT_PLUGIN_SKILLS_DIR = 'skills'

/** Fixed MCP configuration location (§6.1 / §7.2.1). Never configurable. */
export const AGENT_PLUGIN_MCP_FILE = 'mcp.json'

/** Copse's reverse-domain extension namespace (§8) — reverse of `copse.dev`. */
export const COPSE_EXTENSION_NAMESPACE = 'dev.copse'

/** The Agent Plugins release this client implements. */
export const AGENT_PLUGINS_SPEC_VERSION = '1.0.0'

/**
 * The canonical `$schema` identifier for the plugin manifest (§5.2). Clients
 * MUST select validation rules from this value and MUST NOT retrieve the schema
 * while loading a plugin, so this is a string comparison and never a fetch.
 */
export const AGENT_PLUGIN_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/** Top-level fields the closed manifest schema permits (§5.2). */
const PERMITTED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
])

/** Why a plugin was rejected — the boundary the message should describe. */
export type AgentPluginErrorKind =
  /** The Agent Plugins envelope itself is invalid; the plugin is not conformant. */
  | 'envelope'
  /** The envelope is fine but Copse declines this `dev.copse` block. */
  | 'copse-extension'
  /** A conformant plugin targeting an Agent Plugins version this build lacks. */
  | 'unsupported-version'

export class AgentPluginManifestError extends Error {
  readonly kind: AgentPluginErrorKind

  constructor(kind: AgentPluginErrorKind, message: string) {
    super(message)
    this.name = 'AgentPluginManifestError'
    this.kind = kind
  }
}

/**
 * §5.5 plugin name constraints. Exported because discovery reports the specific
 * violated rule, and because an exported predicate over untrusted input earns
 * its own test (AGENTS.md type-safety discipline).
 */
export function isValidAgentPluginName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false
  // First and last characters alphanumeric; interior may add `-` and `.`.
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)) return false
  // No consecutive hyphens or periods.
  return !name.includes('--') && !name.includes('..')
}

/** The AP core envelope. Metadata fields are validated by JSON type only (§5.4). */
const zAuthor = z.strictObject({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
})

const zEnvelope = z.object({
  $schema: z.string(),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: zAuthor.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
})

/**
 * Publisher metadata the spec standardizes and Copse's pack manifest never had.
 * The marketplace install record wants provenance and the Settings row wants
 * something to show; both read this rather than inventing a vocabulary.
 */
export interface AgentPluginMetadata {
  readonly author?: { readonly name?: string; readonly email?: string; readonly url?: string }
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
}

const zStability = z.enum(['stable', 'experimental'])

const zToolsDecl = z.strictObject({
  native: z.array(z.string().min(1).max(128)).max(1_000).optional(),
  acpTools: z.array(z.string().min(1).max(128)).max(1_000).optional(),
  provides: z.array(z.string().min(1).max(128)).max(1_000).optional(),
})

const zModelsDecl = z.strictObject({
  provides: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        label: z.string().min(1).max(256),
        group: z.string().min(1).max(256).optional(),
        description: z.string().max(2_000).optional(),
        supportsImages: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(1_000),
})

const zBrowserDecl = z.strictObject({
  origins: z.array(z.string().min(1).max(2_048)).min(1).max(64),
})

const zRuntimeDecl = z.strictObject({
  entrypoint: z.string().min(1).max(1_000),
  apiVersion: z.literal(1),
})

const zCommandHook = z.strictObject({
  event: z.string().min(1).max(128),
  command: z.string().min(1).max(2_000),
})

const zPromptBlock = z.strictObject({
  id: z.string().min(1).max(128),
  text: z.string().max(64_000),
  trust: z.enum(['trusted', 'untrusted']).optional(),
})

const zUiContribution = z.strictObject({
  id: z.string().min(1).max(128),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  slot: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(256).optional(),
  panel: z
    .strictObject({
      kind: z.enum(['list', 'tree']),
      header: z.string().max(256).optional(),
      ariaLabel: z.string().max(256).optional(),
    })
    .optional(),
})

const zCapabilityDecl = z.strictObject({
  name: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
})

const zPermissionDecl = z.strictObject({
  name: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
  scope: z.enum(['project', 'workspace']).optional(),
})

const zSettingField = z.strictObject({
  kind: z.enum(['boolean', 'string', 'number', 'enum', 'model']),
  title: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
  default: z.union([z.boolean(), z.string(), z.number()]).optional(),
  options: z.array(z.string().max(256)).max(256).optional(),
})

const zStorageDecl = z.strictObject({
  namespace: z.string().min(1).max(128),
})

/**
 * The `extensions["dev.copse"]` block — every Copse contribution kind beyond the
 * two the spec standardizes. Strict: a typo here is a Copse-side rejection, not
 * a silently inert slot.
 */
const zCopseExtension = z.strictObject({
  stability: zStability.optional(),
  tools: zToolsDecl.optional(),
  models: zModelsDecl.optional(),
  browser: zBrowserDecl.optional(),
  runtime: zRuntimeDecl.optional(),
  hooks: z.array(zCommandHook).max(256).optional(),
  prompt: z.array(zPromptBlock).max(256).optional(),
  ui: z.array(zUiContribution).max(256).optional(),
  capabilities: z.array(zCapabilityDecl).max(256).optional(),
  permissions: z.array(zPermissionDecl).max(256).optional(),
  settings: z.record(z.string().min(1).max(128), zSettingField).optional(),
  storage: zStorageDecl.optional(),
})

/** A parsed Agent Plugin, projected onto Copse's internal manifest type. */
export interface AgentPluginParseResult {
  readonly manifest: PackManifest
  readonly metadata: AgentPluginMetadata
  /**
   * Non-fatal findings the client MUST report but MUST NOT reject for (§5.2,
   * §8.1, §11.3) — plus the hardening this parse applied to a user plugin.
   * Callers log these; they never change the outcome.
   */
  readonly warnings: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a raw `plugin.json` value into a {@link PackManifest}.
 *
 * The result is always a **user** plugin: the same two-capability-tiers bar the
 * marketplace plan sets (decision 5) and #1342 carried. Anything a disk manifest
 * could use to claim first-party power is stripped here rather than at
 * registration, so no caller can forget to.
 */
export function parseAgentPluginManifest(raw: unknown): AgentPluginParseResult {
  if (!isRecord(raw)) {
    throw new AgentPluginManifestError(
      'envelope',
      `${AGENT_PLUGIN_MANIFEST_FILE} must be a JSON object.`,
    )
  }

  const warnings: string[] = []

  // §5.2: unknown top-level fields are reported and ignored, never fatal, and
  // never assigned semantics. Client-specific data belongs under `extensions`.
  for (const key of Object.keys(raw)) {
    if (!PERMITTED_TOP_LEVEL_FIELDS.has(key)) {
      warnings.push(`Ignoring unknown top-level field ${JSON.stringify(key)} (Agent Plugins §5.2).`)
    }
  }

  const envelope = zEnvelope.safeParse(raw)
  if (!envelope.success) {
    const field = envelope.error.issues[0]?.path.join('.') ?? 'manifest'
    throw new AgentPluginManifestError(
      'envelope',
      `${AGENT_PLUGIN_MANIFEST_FILE} field ${JSON.stringify(field)} is missing or invalid.`,
    )
  }

  // §5.2: an unrecognized `$schema` means an Agent Plugins version this build
  // does not implement. Reject and report the version rather than guessing that
  // a future format is backward compatible.
  if (envelope.data.$schema !== AGENT_PLUGIN_SCHEMA_ID) {
    throw new AgentPluginManifestError(
      'unsupported-version',
      `Unsupported Agent Plugins schema ${JSON.stringify(envelope.data.$schema)}; this build implements ${AGENT_PLUGIN_SCHEMA_ID}.`,
    )
  }

  if (!isValidAgentPluginName(envelope.data.name)) {
    throw new AgentPluginManifestError(
      'envelope',
      `Plugin name ${JSON.stringify(envelope.data.name)} violates Agent Plugins §5.5 (1-64 chars, lowercase a-z 0-9 - . , alphanumeric ends, no "--" or "..").`,
    )
  }

  const extension = readCopseExtension(raw['extensions'], warnings)

  const manifest: PackManifest = {
    name: envelope.data.name,
    // A discovered manifest is always a user plugin. First-party trust is
    // assigned by code, never claimed by a file.
    trust: 'user',
    // A plugin that makes no support claim must never look stable by omission.
    stability: extension?.stability ?? 'experimental',
  }
  if (envelope.data.version !== undefined) manifest.version = envelope.data.version
  if (envelope.data.description !== undefined) manifest.description = envelope.data.description

  applyCopseExtension(manifest, extension, warnings)

  const metadata: AgentPluginMetadata = {}
  return {
    manifest,
    metadata: Object.assign(metadata, {
      author: envelope.data.author,
      homepage: envelope.data.homepage,
      repository: envelope.data.repository,
      license: envelope.data.license,
      keywords: envelope.data.keywords,
    }),
    warnings,
  }
}

type CopseExtension = z.infer<typeof zCopseExtension>

/**
 * Read `extensions["dev.copse"]`, applying §8.1's asymmetry: a non-object
 * `extensions` is reported and ignored, while a malformed block *inside* our own
 * namespace is ours to reject. Namespaces belonging to other clients are never
 * validated — the spec is explicit that we must ignore them without looking
 * inside.
 */
function readCopseExtension(raw: unknown, warnings: string[]): CopseExtension | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    warnings.push('Ignoring non-object `extensions` field (Agent Plugins §8.1).')
    return undefined
  }
  const block = raw[COPSE_EXTENSION_NAMESPACE]
  if (block === undefined) return undefined
  if (!isRecord(block)) {
    throw new AgentPluginManifestError(
      'copse-extension',
      `extensions["${COPSE_EXTENSION_NAMESPACE}"] must be an object.`,
    )
  }
  const parsed = zCopseExtension.safeParse(block)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'extension'
    throw new AgentPluginManifestError(
      'copse-extension',
      `extensions["${COPSE_EXTENSION_NAMESPACE}"] field ${JSON.stringify(field)} is invalid.`,
    )
  }
  return parsed.data
}

/**
 * Fold the `dev.copse` block onto the manifest, applying user-plugin hardening.
 *
 * Every strip below is a capability a disk manifest must not be able to
 * self-grant (marketplace decisions 4-6). They are warnings rather than
 * rejections so that a plugin authored against a client with more privilege
 * still loads with its safe half intact.
 */
function applyCopseExtension(
  manifest: PackManifest,
  extension: CopseExtension | undefined,
  warnings: string[],
): void {
  if (!extension) return

  if (extension.tools) {
    // `native` and `acpTools` register in-process Copse tools and expose them
    // over the ACP bridge — first-party only. `provides` is implemented by the
    // plugin's own isolated runtime, so it survives.
    if (extension.tools.native) {
      warnings.push('Ignoring `tools.native`: a user plugin cannot register native Copse tools.')
    }
    if (extension.tools.acpTools) {
      warnings.push(
        'Ignoring `tools.acpTools`: a user plugin cannot expose tools over the ACP bridge.',
      )
    }
    if (extension.tools.provides) {
      const tools: PackToolsDecl = { provides: extension.tools.provides }
      manifest.tools = tools
    }
  }

  if (extension.models) {
    const models: PackModelsDecl = {
      provides: extension.models.provides.map((route) => ({
        id: route.id,
        label: route.label,
        ...(route.group === undefined ? {} : { group: route.group }),
        ...(route.description === undefined ? {} : { description: route.description }),
        ...(route.supportsImages === undefined ? {} : { supportsImages: route.supportsImages }),
      })),
    }
    manifest.models = models
  }
  if (extension.browser) {
    const browser: PackBrowserDecl = { origins: extension.browser.origins }
    manifest.browser = browser
  }
  if (extension.runtime) {
    const runtime: PackToolRuntimeDecl = {
      entrypoint: extension.runtime.entrypoint,
      apiVersion: extension.runtime.apiVersion,
    }
    manifest.runtime = runtime
  }
  if (extension.hooks) {
    const hooks: readonly PackCommandHookDecl[] = extension.hooks.map((hook) => ({
      event: hook.event,
      command: hook.command,
    }))
    manifest.hooks = hooks
  }
  if (extension.prompt) {
    // Never trusted, whatever the file claims: `trusted` means verbatim
    // injection past the untrusted-data delimiting, which is a prompt-injection
    // escalation a downloaded manifest must not be able to self-grant.
    if (extension.prompt.some((block) => block.trust === 'trusted')) {
      warnings.push(
        'Forcing prompt blocks to `untrusted`: a user plugin cannot declare trusted prompt.',
      )
    }
    const prompt: readonly PackPromptBlock[] = extension.prompt.map((block) => ({
      id: block.id,
      text: block.text,
      trust: 'untrusted',
    }))
    manifest.prompt = prompt
  }
  if (extension.ui) {
    // Level 3 is a real renderer view — first-party only (VS Code's
    // built-in-extensions model). Levels 1 and 2 are declarative and survive.
    const kept = extension.ui.filter((contribution) => contribution.level !== 3)
    if (kept.length !== extension.ui.length) {
      warnings.push('Ignoring level-3 UI contributions: a user plugin cannot ship renderer code.')
    }
    const ui: readonly PackUiContribution[] = kept.map((contribution) => {
      const next: PackUiContribution = { id: contribution.id, level: contribution.level }
      if (contribution.slot !== undefined) next.slot = contribution.slot
      if (contribution.title !== undefined) next.title = contribution.title
      if (contribution.panel !== undefined) {
        const panel: PanelContributionDecl = {
          kind: contribution.panel.kind,
          ...(contribution.panel.header === undefined ? {} : { header: contribution.panel.header }),
          ...(contribution.panel.ariaLabel === undefined
            ? {}
            : { ariaLabel: contribution.panel.ariaLabel }),
        }
        next.panel = panel
      }
      return next
    })
    if (ui.length > 0) manifest.ui = ui
  }
  if (extension.capabilities) {
    const capabilities: readonly PackCapabilityDecl[] = extension.capabilities.map((decl) => ({
      name: decl.name,
      title: decl.title,
      ...(decl.description === undefined ? {} : { description: decl.description }),
    }))
    manifest.capabilities = capabilities
  }
  if (extension.permissions) {
    const permissions: readonly PackPermissionDecl[] = extension.permissions.map((decl) => ({
      name: decl.name,
      title: decl.title,
      ...(decl.description === undefined ? {} : { description: decl.description }),
      ...(decl.scope === undefined ? {} : { scope: decl.scope }),
    }))
    manifest.permissions = permissions
  }
  if (extension.settings) {
    const settings: PackSettingsSchema = {}
    for (const [key, field] of Object.entries(extension.settings)) {
      settings[key] = {
        kind: field.kind,
        title: field.title,
        ...(field.description === undefined ? {} : { description: field.description }),
        ...(field.default === undefined ? {} : { default: field.default }),
        ...(field.options === undefined ? {} : { options: field.options }),
      }
    }
    manifest.settings = settings
  }
  if (extension.storage) {
    const storage: PackStorageDecl = { namespace: extension.storage.namespace }
    manifest.storage = storage
  }
}
