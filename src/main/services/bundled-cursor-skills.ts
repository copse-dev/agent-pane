import { accessSync, constants, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { resolvePluginSkillsDir } from './cursor-plugins.ts'
import { ensureBundledCursorSkillsSynced } from './bundled-cursor-skills-sync.ts'

let bundledRootOverride: string | null | undefined

export function getBundledCursorSkillsCacheDir(): string {
  if (bundledRootOverride !== undefined && bundledRootOverride !== null) {
    return bundledRootOverride
  }
  return join(app.getPath('userData'), 'bundled-cursor-skills')
}

export function getBundledCursorSkillsRoot(): string | null {
  if (bundledRootOverride !== undefined) {
    return bundledRootOverride
  }
  const cacheDir = getBundledCursorSkillsCacheDir()
  try {
    accessSync(cacheDir, constants.F_OK)
    return cacheDir
  } catch {
    return null
  }
}

/** Sync from GitHub if needed, then list plugin roots cached under userData. */
export async function listBundledCursorPluginRoots(): Promise<string[]> {
  if (bundledRootOverride === null) return []

  const cacheDir = getBundledCursorSkillsCacheDir()
  if (bundledRootOverride === undefined) {
    try {
      await ensureBundledCursorSkillsSynced(cacheDir)
    } catch (err) {
      console.warn(
        '[skills] Bundled Cursor skills sync failed:',
        err instanceof Error ? err.message : err,
      )
      return []
    }
  }

  const root = bundledRootOverride ?? cacheDir

  const pluginsDir = join(root, 'plugins')
  let entries: string[]
  try {
    entries = readdirSync(pluginsDir)
  } catch {
    return []
  }

  const out: string[] = []
  for (const name of entries) {
    const pluginRoot = join(pluginsDir, name)
    const skillsDir = await resolvePluginSkillsDir(pluginRoot)
    if (skillsDir) out.push(pluginRoot)
  }
  return out.sort()
}

export function setBundledCursorSkillsRootForTest(root: string | null): void {
  bundledRootOverride = root
}

export function resetBundledCursorSkillsRootForTest(): void {
  bundledRootOverride = undefined
}
