// Host disk discovery for marketplace P1 — local user packs.
//
// Scans a Copse-owned packs root for immediate child directories that contain a
// pack manifest, maps each through {@link registeredUserPackFromDiskJson}, and
// registers them on the shared {@link PackRegistry}. No network. Cursor plugin
// import (`~/.cursor/plugins/`) stays a separate read-only path.
//
// Default root: `~/.copse/packs/` (Open Q1 resolved — beside the workspace
// thread store, not under Electron userData). Override with `COPSE_PACKS_DIR`
// for tests / relocation. Missing root ⇒ inert (no timers, no errors).
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import { DuplicatePackError } from '@copse/agent/packs/pack-registry.ts'
import {
  registeredUserPackFromDiskJson,
  type UserPackHardeningNote,
} from '@copse/agent/packs/user-pack-from-disk.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** Manifest filenames accepted inside a pack directory (first match wins). */
export const USER_PACK_MANIFEST_CANDIDATES = [
  'copse-pack.json',
  'plugin.json',
  join('.cursor-plugin', 'plugin.json'),
] as const

/** One discovered (or skipped) pack directory. */
export interface UserPackDiscoveryEntry {
  readonly dirName: string
  readonly packDir: string
  readonly manifestPath: string
  readonly packId?: string
  readonly status: 'registered' | 'skipped'
  readonly reason?: string
  readonly notes: readonly UserPackHardeningNote[]
}

/** Aggregate result of a discovery pass. */
export interface UserPackDiscoveryResult {
  readonly root: string
  readonly entries: readonly UserPackDiscoveryEntry[]
}

/**
 * Copse-owned user-pack root. Prefer `COPSE_PACKS_DIR` when set (tests); otherwise
 * `~/.copse/packs` next to the workspace thread store.
 */
export function userPacksRoot(): string {
  const override = process.env['COPSE_PACKS_DIR']?.trim()
  if (override && override.length > 0) return override
  return join(homedir(), '.copse', 'packs')
}

/**
 * Resolve the manifest path inside a pack directory, or `null` when none of the
 * candidate filenames exist.
 */
export function resolveUserPackManifestPath(packDir: string): string | null {
  for (const relative of USER_PACK_MANIFEST_CANDIDATES) {
    const candidate = join(packDir, relative)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Discover user packs under `root` (default {@link userPacksRoot}) and register
 * each onto `registry`. Duplicate ids (including collisions with first-party
 * packs) and unreadable manifests are skipped — discovery never throws for a
 * single bad neighbour, so one broken pack cannot take down Settings → Packs.
 */
export function discoverAndRegisterUserPacks(
  registry: PackRegistry,
  root: string = userPacksRoot(),
): UserPackDiscoveryResult {
  const entries: UserPackDiscoveryEntry[] = []
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { root, entries }
  }

  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { root, entries }
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    if (dirent.name.startsWith('.')) continue
    const packDir = join(root, dirent.name)
    const manifestPath = resolveUserPackManifestPath(packDir)
    if (!manifestPath) continue

    const base = {
      dirName: dirent.name,
      packDir,
      manifestPath,
      notes: [] as UserPackHardeningNote[],
    }

    let rawText: string
    try {
      rawText = fs.readFileSync(manifestPath, 'utf8')
    } catch (err) {
      entries.push({
        ...base,
        status: 'skipped',
        reason: `unreadable manifest: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText) as unknown
    } catch (err) {
      entries.push({
        ...base,
        status: 'skipped',
        reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    if (!isRecord(parsed)) {
      entries.push({
        ...base,
        status: 'skipped',
        reason: 'manifest root must be a JSON object',
      })
      continue
    }

    try {
      const { pack, notes } = registeredUserPackFromDiskJson(parsed, {
        sourceHint: basename(packDir),
      })
      registry.register(pack)
      entries.push({
        ...base,
        packId: pack.id,
        status: 'registered',
        notes,
      })
    } catch (err) {
      const reason =
        err instanceof DuplicatePackError
          ? `duplicate pack id "${err.packId}"`
          : err instanceof Error
            ? err.message
            : String(err)
      entries.push({
        ...base,
        status: 'skipped',
        reason,
      })
    }
  }

  return { root, entries }
}
