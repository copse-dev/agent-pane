import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_CURSOR_SKILLS_VENDOR_DIR,
  syncBundledCursorSkills,
} from './bundled-cursor-skills-sync.mts'

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Replace the tracked snapshot only after a complete staged download validates. */
export async function updateBundledCursorSkills(): Promise<void> {
  const parent = dirname(BUNDLED_CURSOR_SKILLS_VENDOR_DIR)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, '.bundled-cursor-skills-staging-'))
  const backup = resolve(parent, `.bundled-cursor-skills-backup-${String(process.pid)}`)
  let backedUp = false

  try {
    const source = await syncBundledCursorSkills(staging)
    await rm(backup, { recursive: true, force: true })
    if (await pathExists(BUNDLED_CURSOR_SKILLS_VENDOR_DIR)) {
      await rename(BUNDLED_CURSOR_SKILLS_VENDOR_DIR, backup)
      backedUp = true
    }
    try {
      await rename(staging, BUNDLED_CURSOR_SKILLS_VENDOR_DIR)
    } catch (error) {
      if (backedUp) await rename(backup, BUNDLED_CURSOR_SKILLS_VENDOR_DIR)
      throw error
    }
    await rm(backup, { recursive: true, force: true })
    backedUp = false
    console.log(
      `[sync-bundled-cursor-skills] wrote ${String(source.skillCount)} skills from ` +
        `${String(source.pluginCount)} plugins @ ${source.commit.slice(0, 12)} ` +
        `(${source.contentSha256.slice(0, 12)})`,
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
    if (!backedUp) await rm(backup, { recursive: true, force: true })
  }
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isCli) {
  try {
    await updateBundledCursorSkills()
  } catch (error) {
    console.error('[sync-bundled-cursor-skills]', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
