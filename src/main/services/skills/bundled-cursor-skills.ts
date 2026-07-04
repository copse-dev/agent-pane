import { accessSync, constants, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePluginSkillsDir } from './cursor-plugins.ts'

/** Gitignored build artifact — see scripts/fetch-bundled-cursor-skills.mts */
export const BUNDLED_CURSOR_SKILLS_VENDOR_DIR = 'vendor/bundled-cursor-skills'

let bundledRootOverride: string | null | undefined

/** Resolve bundled skills shipped with the app (dist/resources) or dev vendor tree. */
export function getBundledCursorSkillsRoot(): string | null {
  if (bundledRootOverride !== undefined) return bundledRootOverride

  const candidates = [
    join(__dirname, '../resources/bundled-cursor-skills'),
    join(__dirname, '../../vendor/bundled-cursor-skills'),
  ]

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}

export async function listBundledCursorPluginRoots(): Promise<string[]> {
  if (bundledRootOverride === null) return []

  const root = getBundledCursorSkillsRoot()
  if (!root) return []

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
