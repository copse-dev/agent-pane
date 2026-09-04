import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { copseUserDataDir } from './copse-paths.ts'

/**
 * Why the profile ended up where it did. `moved` and `copied` are the migration
 * actually happening; `failed` means the legacy directory is still authoritative
 * and Copse keeps using it rather than booting into an empty profile.
 */
export type UserDataMigrationOutcome =
  | 'moved'
  | 'copied'
  | 'no-legacy-profile'
  | 'explicit-profile'
  | 'already-migrated'
  | 'target-in-use'
  | 'failed'

export interface UserDataLocation {
  /** The directory Electron should actually use for `userData`. */
  readonly dir: string
  readonly outcome: UserDataMigrationOutcome
  /** Present only for `failed`, for the startup log line. */
  readonly error?: unknown
}

/** macOS sprinkles these into any directory a user opens in Finder. */
const IGNORED_ENTRIES = new Set(['.DS_Store'])

function hasRealContent(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => !IGNORED_ENTRIES.has(entry))
  } catch {
    // Unreadable is not empty — treat it as occupied so we never move onto it.
    return true
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isCrossDeviceError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EXDEV'
  )
}

/**
 * Move a pre-existing Electron profile into the Copse data root.
 *
 * Copse used to leave `config.json`, `settings.json`, `mcp.json`, `tools/`, the
 * browser profiles and the semantic index in Electron's default
 * `<appData>/copse-panel`, while threads, worktrees and knowledge lived under
 * `~/.copse`. Backing Copse up meant copying two unrelated directories and
 * restoring them as a matched pair; moving to another machine meant the same.
 * Everything now lives under {@link copseUserDataDir}, so this carries an
 * existing profile across once.
 *
 * Runs synchronously and before `app.setPath('userData', …)`, because
 * electron-store resolves its file path when it is constructed.
 *
 * Failure is never fatal and never silently starts a blank profile: if anything
 * goes wrong the legacy directory is returned unchanged and Copse keeps running
 * against it, so the worst case is that the migration retries next launch.
 */
export function resolveUserDataDir(
  legacyDir: string,
  env: NodeJS.ProcessEnv = process.env,
): UserDataLocation {
  // An explicit profile means "use exactly this directory" — the e2e and eval
  // harnesses hand out a throwaway one per run and must never inherit a real
  // profile, nor consume the legacy directory the daily app still uses.
  if (env['COPSE_PANEL_USER_DATA']?.trim()) {
    return { dir: copseUserDataDir(env), outcome: 'explicit-profile' }
  }

  const target = copseUserDataDir(env)
  if (resolve(legacyDir) === resolve(target)) {
    return { dir: target, outcome: 'already-migrated' }
  }
  if (!isDirectory(legacyDir)) {
    return { dir: target, outcome: 'no-legacy-profile' }
  }
  if (isDirectory(target) && hasRealContent(target)) {
    // Both profiles hold data. Merging them would interleave two config.json
    // generations, so keep the migrated one and leave the legacy directory for
    // the user to reconcile or delete.
    return { dir: target, outcome: 'target-in-use' }
  }

  // Anything at the target that is not a directory is a state we did not create
  // and must not delete; fall back to the legacy profile rather than guess.
  if (existsSync(target) && !isDirectory(target)) {
    return {
      dir: legacyDir,
      outcome: 'failed',
      error: new Error(`${target} exists and is not a directory`),
    }
  }

  try {
    mkdirSync(dirname(target), { recursive: true })
    // An empty (or Finder-littered) target would make rename fail on Windows and
    // silently nest on some POSIX implementations.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })

    try {
      renameSync(legacyDir, target)
      return { dir: target, outcome: 'moved' }
    } catch (error) {
      if (!isCrossDeviceError(error)) throw error
      // COPSE_DIR pointed at another volume. Copy, then park the legacy
      // directory rather than deleting it — cpSync is not transactional, so a
      // partial copy must stay recoverable.
      cpSync(legacyDir, target, { recursive: true })
      rmSync(`${legacyDir}.migrated`, { recursive: true, force: true })
      renameSync(legacyDir, `${legacyDir}.migrated`)
      return { dir: target, outcome: 'copied' }
    }
  } catch (error) {
    // Another instance winning the race leaves the target populated and the
    // legacy directory gone; that is a completed migration, not a failure.
    if (!isDirectory(legacyDir) && isDirectory(target)) {
      return { dir: target, outcome: 'already-migrated' }
    }
    return { dir: legacyDir, outcome: 'failed', error }
  }
}
