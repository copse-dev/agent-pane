import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_CURSOR_PLUGINS_COMMIT,
  bundledCursorSkillsSourceSchema,
  syncBundledCursorSkills,
  type BundledCursorSkillsSource,
} from './bundled-cursor-skills-sync.mts'

export const BUNDLED_CURSOR_SKILLS_OUT_DIR = resolve('vendor/bundled-cursor-skills')

async function readSourceManifest(cacheDir: string): Promise<BundledCursorSkillsSource | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(resolve(cacheDir, 'SOURCE.json'), 'utf8')
    const parsed = bundledCursorSkillsSourceSchema.parse(JSON.parse(raw) as unknown)
    if (parsed.commit !== BUNDLED_CURSOR_PLUGINS_COMMIT) return null
    if (parsed.skillCount <= 0) return null
    return parsed
  } catch {
    return null
  }
}

/** Fetch slim SKILL.md cache into vendor/ (gitignored). Idempotent when commit matches. */
export async function fetchBundledCursorSkills(): Promise<BundledCursorSkillsSource | null> {
  if (process.env['SKIP_BUNDLED_CURSOR_SKILLS_FETCH'] === '1') {
    console.log('[fetch-bundled-cursor-skills] SKIP_BUNDLED_CURSOR_SKILLS_FETCH=1 — skipping')
    return null
  }

  const existing = await readSourceManifest(BUNDLED_CURSOR_SKILLS_OUT_DIR)
  if (existing) {
    console.log(
      `[fetch-bundled-cursor-skills] ${String(existing.skillCount)} skills already present @ ${existing.commit.slice(0, 12)}`,
    )
    return existing
  }

  try {
    await mkdir(BUNDLED_CURSOR_SKILLS_OUT_DIR, { recursive: true })
    const source = await syncBundledCursorSkills(BUNDLED_CURSOR_SKILLS_OUT_DIR)
    console.log(
      `[fetch-bundled-cursor-skills] synced ${String(source.skillCount)} skills from ${String(source.pluginCount)} plugins`,
    )
    return source
  } catch (err) {
    console.warn(
      '[fetch-bundled-cursor-skills]',
      err instanceof Error ? err.message : err,
      '— bundled Cursor skills will be unavailable until fetch succeeds',
    )
    return null
  }
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isCli) {
  void fetchBundledCursorSkills()
}
