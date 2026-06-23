/**
 * Prime the bundled Cursor skills cache (SKILL.md only) under Copse userData or a custom path.
 * The app also syncs automatically on first launch when bundled skills are enabled.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { syncBundledCursorSkills } from '../src/main/services/bundled-cursor-skills-sync.ts'

const defaultCache = join(homedir(), '.config', 'copse-panel', 'bundled-cursor-skills')
const cacheDir = resolve(process.argv[2] ?? defaultCache)

mkdirSync(cacheDir, { recursive: true })
const source = await syncBundledCursorSkills(cacheDir)
console.log(`Synced ${source.skillCount} skills from ${source.pluginCount} plugins to ${cacheDir}`)
