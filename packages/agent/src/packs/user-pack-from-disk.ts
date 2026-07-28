// Turn a parsed on-disk pack manifest into a {@link RegisteredPack}.
//
// Marketplace P1 (`docs/plans/feature-pack-marketplace.md`): host disk discovery
// feeds this helper so a local `plugin.json` / `copse-pack.json` becomes a
// **user** pack row. Pure and Electron-free — the host owns the filesystem walk.
//
// Trust hardening (binding decisions + packs.md):
//  - trust is always `user` (via {@link packManifestFromPluginJson})
//  - prompt blocks are forced `untrusted`
//  - `tools.native` is stripped (user packs cannot smuggle native Copse tools)
//  - level-3 UI contributions are dropped (first-party only)
//  - executable contributions copy only the declarative, safe slots so Settings
//    and `activePromptBlocks()` see the pack while enable/disable stays atomic
import {
  definePack,
  packManifestFromPluginJson,
  type PackManifest,
  type PackToolsDecl,
  type PackUiContribution,
  type RegisteredPack,
} from './pack-manifest.ts'
import { isRecord } from '../internal-utils.ts'

/** One rejected contribution / field while hardening a user pack. */
export interface UserPackHardeningNote {
  readonly kind: 'stripped-native-tools' | 'dropped-level-3-ui'
  readonly detail: string
}

/** Result of mapping a parsed manifest into a registerable user pack. */
export interface UserPackFromDisk {
  readonly pack: RegisteredPack
  readonly notes: readonly UserPackHardeningNote[]
}

/**
 * Build a {@link RegisteredPack} from a parsed on-disk manifest object.
 *
 * `sourceHint` distinguishes nameless manifests (usually the pack directory
 * basename) so two incomplete files do not collide on `unnamed-pack`.
 */
export function registeredUserPackFromDiskJson(
  raw: unknown,
  opts?: { sourceHint?: string },
): UserPackFromDisk {
  if (!isRecord(raw)) {
    throw new Error('pack manifest must be a JSON object')
  }
  const notes: UserPackHardeningNote[] = []
  const manifest = hardenUserPackManifest(packManifestFromPluginJson(raw, opts), notes)
  return {
    pack: definePack(manifest, {
      // Prompt blocks must live on contributions — `activePromptBlocks()` and
      // Settings projection read that slot, not `manifest.prompt`.
      promptBlocks: manifest.prompt ?? [],
      uiContributions: manifest.ui ?? [],
      capabilities: manifest.capabilities ?? [],
      permissions: manifest.permissions ?? [],
      // Never copy tools.native — stripped above. MCP path stays declarative on
      // the manifest for Settings; runtime MCP wiring follows in a later phase.
    }),
    notes,
  }
}

/**
 * Drop first-party-only claims from a user-pack manifest after the plugin.json
 * mapper has already forced `trust: 'user'` and untrusted prompt framing.
 */
function hardenUserPackManifest(
  manifest: PackManifest,
  notes: UserPackHardeningNote[],
): PackManifest {
  const next: PackManifest = { ...manifest }

  if (manifest.tools?.native !== undefined && manifest.tools.native.length > 0) {
    notes.push({
      kind: 'stripped-native-tools',
      detail: `ignored native tools: ${manifest.tools.native.join(', ')}`,
    })
    const tools: PackToolsDecl = {}
    if (manifest.tools.mcpServers !== undefined) tools.mcpServers = manifest.tools.mcpServers
    if (tools.mcpServers !== undefined) next.tools = tools
    else delete next.tools
  }

  if (manifest.ui && manifest.ui.length > 0) {
    const kept: PackUiContribution[] = []
    const dropped: string[] = []
    for (const contribution of manifest.ui) {
      if (contribution.level === 3) {
        dropped.push(contribution.id)
        continue
      }
      kept.push(contribution)
    }
    if (dropped.length > 0) {
      notes.push({
        kind: 'dropped-level-3-ui',
        detail: `ignored level-3 UI contributions: ${dropped.join(', ')}`,
      })
    }
    if (kept.length > 0) next.ui = kept
    else delete next.ui
  }

  return next
}
