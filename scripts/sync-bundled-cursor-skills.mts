/**
 * Vendor official Cursor marketplace skills from github.com/cursor/plugins.
 * Run after bumping BUNDLED_CURSOR_PLUGINS_REF to refresh vendor/bundled-cursor-skills/.
 */
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'

const REPO = 'https://github.com/cursor/plugins.git'
const REF = 'main'
const OUT = resolve('vendor/bundled-cursor-skills')
const CLONE = resolve('.tmp/cursor-plugins-sync')

function run(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' })
}

function pluginHasSkills(skillsDir: string): number {
  let count = 0
  for (const name of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, name, 'SKILL.md')
    try {
      if (statSync(skillMd).isFile()) count++
    } catch {
      // not a skill folder
    }
  }
  return count
}

function main(): void {
  rmSync(CLONE, { recursive: true, force: true })
  mkdirSync(CLONE, { recursive: true })
  run(`git clone --depth 1 --branch ${REF} ${REPO} ${CLONE}`)
  const commit = execSync('git rev-parse HEAD', { cwd: CLONE, encoding: 'utf8' }).trim()

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'plugins'), { recursive: true })

  const marketplace = JSON.parse(
    readFileSync(join(CLONE, '.cursor-plugin', 'marketplace.json'), 'utf8'),
  ) as { plugins: { name: string; source: string }[] }

  let pluginCount = 0
  let skillCount = 0

  for (const entry of marketplace.plugins) {
    const pluginDir = join(CLONE, entry.source)
    const manifestPath = join(pluginDir, '.cursor-plugin', 'plugin.json')
    try {
      readFileSync(manifestPath)
    } catch {
      continue
    }

    const skillsDir = join(pluginDir, 'skills')
    let count: number
    try {
      count = pluginHasSkills(skillsDir)
    } catch {
      continue
    }
    if (count === 0) continue

    const dest = join(OUT, 'plugins', entry.source)
    mkdirSync(join(dest, '.cursor-plugin'), { recursive: true })
    cpSync(
      join(pluginDir, '.cursor-plugin', 'plugin.json'),
      join(dest, '.cursor-plugin', 'plugin.json'),
    )
    cpSync(skillsDir, join(dest, 'skills'), { recursive: true })
    pluginCount++
    skillCount += count
  }

  writeFileSync(
    join(OUT, 'SOURCE.json'),
    JSON.stringify(
      {
        repository: REPO,
        ref: REF,
        commit,
        syncedAt: new Date().toISOString(),
        pluginCount,
        skillCount,
        license: 'See each plugin directory and https://github.com/cursor/plugins',
      },
      null,
      2,
    ) + '\n',
  )

  console.log(`Synced ${skillCount} skills from ${pluginCount} plugins @ ${commit.slice(0, 12)}`)
}

main()
