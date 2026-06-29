import * as fsp from 'node:fs/promises'
import { join } from 'node:path'

/** Pinned upstream commit from https://github.com/cursor/plugins */
export const BUNDLED_CURSOR_PLUGINS_COMMIT = 'e46364b8be46000b7df0f260550cd712afbb8d36'

export const BUNDLED_CURSOR_PLUGINS_REPO = 'cursor/plugins'

const RAW_BASE = `https://raw.githubusercontent.com/${BUNDLED_CURSOR_PLUGINS_REPO}/${BUNDLED_CURSOR_PLUGINS_COMMIT}`
const API_BASE = `https://api.github.com/repos/${BUNDLED_CURSOR_PLUGINS_REPO}/contents`

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'copse-panel-bundled-skills-sync',
  'X-GitHub-Api-Version': '2022-11-28',
} as const

interface MarketplaceManifest {
  plugins: { name: string; source: string }[]
}

interface GitHubContentEntry {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  download_url: string | null
}

export interface BundledCursorSkillsSource {
  repository: string
  commit: string
  syncedAt: string
  pluginCount: number
  skillCount: number
  slim: true
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: GITHUB_HEADERS })
  if (!res.ok) {
    throw new Error(`GitHub fetch failed (${String(res.status)}): ${url}`)
  }
  return (await res.json()) as T
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Download failed (${String(res.status)}): ${url}`)
  }
  return res.text()
}

async function listSkillDirs(pluginSource: string): Promise<string[]> {
  const url = `${API_BASE}/${pluginSource}/skills?ref=${BUNDLED_CURSOR_PLUGINS_COMMIT}`
  const entries = await fetchJson<GitHubContentEntry[]>(url)
  return entries.filter((entry) => entry.type === 'dir').map((entry) => entry.name)
}

/** Download only plugin.json + SKILL.md per skill — not scripts, tests, or assets. */
export async function syncBundledCursorSkills(
  cacheDir: string,
): Promise<BundledCursorSkillsSource> {
  const marketplace = await fetchJson<MarketplaceManifest>(
    `${RAW_BASE}/.cursor-plugin/marketplace.json`,
  )

  const pluginsDir = join(cacheDir, 'plugins')
  await fsp.rm(pluginsDir, { recursive: true, force: true })
  await fsp.mkdir(pluginsDir, { recursive: true })

  let pluginCount = 0
  let skillCount = 0

  for (const entry of marketplace.plugins) {
    const pluginSource = entry.source
    const manifestUrl = `${RAW_BASE}/${pluginSource}/.cursor-plugin/plugin.json`
    let manifestRaw: string
    try {
      manifestRaw = await fetchText(manifestUrl)
    } catch {
      continue
    }

    let skillDirs: string[]
    try {
      skillDirs = await listSkillDirs(pluginSource)
    } catch {
      continue
    }
    if (skillDirs.length === 0) continue

    const dest = join(pluginsDir, pluginSource)
    await fsp.mkdir(join(dest, '.cursor-plugin'), { recursive: true })
    await fsp.writeFile(join(dest, '.cursor-plugin', 'plugin.json'), manifestRaw, 'utf8')

    let pluginSkillCount = 0
    for (const skillName of skillDirs) {
      const skillUrl = `${RAW_BASE}/${pluginSource}/skills/${skillName}/SKILL.md`
      let body: string
      try {
        body = await fetchText(skillUrl)
      } catch {
        continue
      }
      const skillDir = join(dest, 'skills', skillName)
      await fsp.mkdir(skillDir, { recursive: true })
      await fsp.writeFile(join(skillDir, 'SKILL.md'), body, 'utf8')
      pluginSkillCount++
      skillCount++
    }

    if (pluginSkillCount > 0) pluginCount++
  }

  if (skillCount === 0) {
    throw new Error('Bundled Cursor skills sync produced zero skills')
  }

  const source: BundledCursorSkillsSource = {
    repository: `https://github.com/${BUNDLED_CURSOR_PLUGINS_REPO}`,
    commit: BUNDLED_CURSOR_PLUGINS_COMMIT,
    syncedAt: new Date().toISOString(),
    pluginCount,
    skillCount,
    slim: true,
  }
  await fsp.writeFile(join(cacheDir, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n', 'utf8')
  return source
}
