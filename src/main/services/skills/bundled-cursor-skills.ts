import { accessSync, constants, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BundledSkillPluginSummary } from '@shared/types/cursor-plugins.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { getSetting } from '../storage/settings.ts'
import {
  readCursorPluginName,
  readPluginManifest,
  resolvePluginSkillsDir,
} from './cursor-plugins.ts'

/** Tracked, hash-verified build input — update only with `pnpm sync:cursor-skills`. */
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

/** Setting: every bundled Cursor plugin's skills at once. Default on. */
export const BUNDLED_CURSOR_SKILLS_SETTING = 'bundledCursorSkillsEnabled'

/** Setting: the user's per-plugin choices, `{ [pluginName]: enabled }`. Absent → the default. */
export const BUNDLED_SKILL_PLUGIN_OVERRIDES_SETTING = 'bundledSkillPluginOverrides'

/**
 * Bundled plugins that ship switched off, and why. A plugin lands here when its
 * skills are written for another harness closely enough that they misfire in
 * Copse rather than merely going unused.
 */
const OFF_BY_DEFAULT: Readonly<Record<string, string>> = {
  pstack:
    'Written for Cursor: its workflows call Cursor subagents and model names, and its ' +
    'autonomy guidance ("just do it") conflicts with how Copse asks before acting.',
}

function bundledSkillPluginOverrides(): ReadonlyMap<string, boolean> {
  const raw: unknown = getSetting(BUNDLED_SKILL_PLUGIN_OVERRIDES_SETTING, {})
  const overrides = new Map<string, boolean>()
  if (!isRecord(raw)) return overrides
  for (const [name, enabled] of Object.entries(raw)) {
    if (typeof enabled === 'boolean') overrides.set(name, enabled)
  }
  return overrides
}

/** Whether one bundled plugin's skills load, ignoring the all-bundled-skills switch. */
export function isBundledSkillPluginEnabled(name: string): boolean {
  return bundledSkillPluginOverrides().get(name) ?? !Object.hasOwn(OFF_BY_DEFAULT, name)
}

function countSkillDirs(skillsDir: string): number {
  return readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .length
}

/** Every bundled plugin with its switch state, for Settings → Plugins. */
export async function listBundledSkillPlugins(): Promise<BundledSkillPluginSummary[]> {
  const suppressed = !getSetting<boolean>(BUNDLED_CURSOR_SKILLS_SETTING, true)
  const summaries: BundledSkillPluginSummary[] = []
  for (const pluginRoot of await listBundledCursorPluginRoots()) {
    const [manifest, name, skillsDir] = await Promise.all([
      readPluginManifest(pluginRoot),
      readCursorPluginName(pluginRoot),
      resolvePluginSkillsDir(pluginRoot),
    ])
    const offByDefaultReason = OFF_BY_DEFAULT[name]
    summaries.push({
      name,
      ...(manifest?.description ? { description: manifest.description } : {}),
      ...(manifest?.version ? { version: manifest.version } : {}),
      skillCount: skillsDir ? countSkillDirs(skillsDir) : 0,
      enabled: isBundledSkillPluginEnabled(name),
      defaultEnabled: offByDefaultReason === undefined,
      ...(offByDefaultReason ? { offByDefaultReason } : {}),
      suppressed,
    })
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name))
}

export function setBundledCursorSkillsRootForTest(root: string | null): void {
  bundledRootOverride = root
}

export function resetBundledCursorSkillsRootForTest(): void {
  bundledRootOverride = undefined
}
