import { type Dirent, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  SENSITIVE_BASENAMES,
  SENSITIVE_DIR_SEGMENTS,
} from '@copse/shell-guard/read-outside-project.ts'
import {
  SANDBOX_READ_APPROVED_FOLDERS_DEFAULT,
  SANDBOX_READ_APPROVED_FOLDERS_SETTING,
  SANDBOX_READ_CACHES_DEFAULT,
  SANDBOX_READ_CACHES_SETTING,
  SANDBOX_READ_TOOLCHAINS_DEFAULT,
  SANDBOX_READ_TOOLCHAINS_SETTING,
  SANDBOX_READ_WORKSPACE_ONLY_DEFAULT,
  SANDBOX_READ_WORKSPACE_ONLY_SETTING,
  effectiveSandboxReadPolicy,
  type SandboxReadAccessPolicy,
  type SandboxReadGroup,
} from '@shared/sandbox-read-access.ts'
import { copseDataRoot } from '../services/storage/copse-paths.ts'
import { getSetting } from '../services/storage/settings.ts'
import { createToolchainReadGuard } from './toolchain-read-guard.ts'

/**
 * Standing read-only roots outside the project (Settings → Permissions →
 * Sandbox read access). Two consumers must agree on them, exactly as they do
 * for a skill's directory (`thread-read-roots.ts`):
 *
 * - the seatbelt overlay (`workspaceSandboxOverlay`) adds each root under home
 *   to `allowRead`, never to `allowWrite`;
 * - the shell-scope classifier (`shell-guard-environment.ts`) lists every root
 *   as a contained read root, so a structurally read-only command naming one
 *   starts inside the sandbox instead of asking to run outside it.
 *
 * Roots outside home (`/Applications/Xcode.app`, `/opt/homebrew`) were already
 * readable inside the sandbox, which denies only home; what changes for them
 * is that a read stops prompting. Every root passes the toolchain read guard,
 * so one that is home, holds home, or contains or sits inside a credential
 * store (`~/.npmrc`, `~/Library/Keychains`, `~/.copse`, …) is dropped.
 */

export interface StandingReadRoot {
  readonly group: SandboxReadGroup
  /** The spelling the candidate list names. */
  readonly path: string
  /** Its realpath, which is what a seatbelt rule has to name. */
  readonly canonical: string
}

/** Current switches, with the workspace-only lockdown applied. */
export function sandboxReadAccessPolicy(): SandboxReadAccessPolicy {
  return effectiveSandboxReadPolicy({
    toolchains: getSetting(SANDBOX_READ_TOOLCHAINS_SETTING, SANDBOX_READ_TOOLCHAINS_DEFAULT),
    caches: getSetting(SANDBOX_READ_CACHES_SETTING, SANDBOX_READ_CACHES_DEFAULT),
    approvedFolders: getSetting(
      SANDBOX_READ_APPROVED_FOLDERS_SETTING,
      SANDBOX_READ_APPROVED_FOLDERS_DEFAULT,
    ),
    workspaceOnly: getSetting(
      SANDBOX_READ_WORKSPACE_ONLY_SETTING,
      SANDBOX_READ_WORKSPACE_ONLY_DEFAULT,
    ),
  })
}

function absoluteEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]
  return value !== undefined && value !== '' && isAbsolute(value) ? value : null
}

/** Every `/Applications/Xcode*.app`, so a beta or a pinned version counts too. */
function xcodeApps(applications: string): string[] {
  try {
    return readdirSync(applications)
      .filter((name) => /^Xcode[^/]*\.app$/.test(name))
      .map((name) => join(applications, name))
  } catch {
    return []
  }
}

/**
 * Toolchain and SDK install roots. Their contents are code someone installed
 * on purpose; a contained command may read them, never write them, so nothing
 * it plants can later run outside the sandbox from one of these `PATH`s.
 */
export function toolchainReadRootCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const cargoHome = absoluteEnv(env, 'CARGO_HOME') ?? join(home, '.cargo')
  const rustupHome = absoluteEnv(env, 'RUSTUP_HOME') ?? join(home, '.rustup')
  const nvmDir = absoluteEnv(env, 'NVM_DIR') ?? join(home, '.nvm')
  const voltaHome = absoluteEnv(env, 'VOLTA_HOME') ?? join(home, '.volta')
  const dataHome = absoluteEnv(env, 'XDG_DATA_HOME') ?? join(home, '.local', 'share')
  const fnmDir = absoluteEnv(env, 'FNM_DIR')
  const paths = [
    ...(platform === 'darwin'
      ? [
          ...xcodeApps('/Applications'),
          '/Library/Developer/CommandLineTools',
          '/opt/homebrew',
          '/usr/local/Homebrew',
          '/usr/local/Cellar',
        ]
      : []),
    ...(platform === 'linux' ? ['/home/linuxbrew/.linuxbrew'] : []),
    ...[absoluteEnv(env, 'DEVELOPER_DIR'), absoluteEnv(env, 'HOMEBREW_PREFIX')].filter(
      (path) => path !== null,
    ),
    join(nvmDir, 'versions'),
    ...(fnmDir
      ? [join(fnmDir, 'node-versions')]
      : [
          join(dataHome, 'fnm', 'node-versions'),
          ...(platform === 'darwin'
            ? [join(home, 'Library', 'Application Support', 'fnm', 'node-versions')]
            : []),
        ]),
    join(voltaHome, 'tools', 'image'),
    join(home, '.asdf', 'installs'),
    join(dataHome, 'mise', 'installs'),
    join(home, '.rbenv', 'versions'),
    join(home, '.pyenv', 'versions'),
    join(dataHome, 'uv', 'python'),
    join(home, '.bun', 'bin'),
    join(cargoHome, 'bin'),
    join(rustupHome, 'toolchains'),
  ]
  return [...new Set(paths)]
}

/**
 * Package caches and build logs: downloaded packages and what a build or a
 * crash wrote, read by agents investigating a failure. Registry credentials
 * live beside these (`~/.npmrc`, `$CARGO_HOME/credentials.toml`), never inside,
 * and the guard drops any root that would cover one.
 */
export function cacheReadRootCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const cargoHome = absoluteEnv(env, 'CARGO_HOME') ?? join(home, '.cargo')
  const cacheHome = absoluteEnv(env, 'XDG_CACHE_HOME') ?? join(home, '.cache')
  const dataHome = absoluteEnv(env, 'XDG_DATA_HOME') ?? join(home, '.local', 'share')
  const goPath = absoluteEnv(env, 'GOPATH') ?? join(home, 'go')
  const caches = join(home, 'Library', 'Caches')
  const paths = [
    join(home, '.npm', '_cacache'),
    join(home, '.npm', '_logs'),
    join(dataHome, 'pnpm', 'store'),
    join(cacheHome, 'pnpm'),
    join(cacheHome, 'yarn'),
    join(home, '.yarn', 'berry', 'cache'),
    join(cacheHome, 'pip'),
    absoluteEnv(env, 'UV_CACHE_DIR') ?? join(cacheHome, 'uv'),
    join(cargoHome, 'registry'),
    join(cargoHome, 'git'),
    absoluteEnv(env, 'GOMODCACHE') ?? join(goPath, 'pkg', 'mod'),
    absoluteEnv(env, 'GOCACHE') ?? join(cacheHome, 'go-build'),
    join(home, '.gradle', 'caches'),
    join(home, '.m2', 'repository'),
    ...(platform === 'darwin'
      ? [
          join(home, 'Library', 'pnpm', 'store'),
          join(caches, 'pnpm'),
          join(caches, 'Yarn'),
          join(caches, 'pip'),
          join(caches, 'go-build'),
          join(caches, 'CocoaPods'),
          // Not Xcode's DerivedData or the crash-report folders: they hold every
          // project's build products, logs and process memory excerpts, which
          // are not package caches and get no credential denies.
        ]
      : []),
  ]
  return [...new Set(paths)]
}

/**
 * Resolve the default groups the policy turns on to existing, guard-approved
 * directories. A missing candidate adds nothing.
 */
export function resolveStandingReadRoots(
  policy: SandboxReadAccessPolicy = sandboxReadAccessPolicy(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): StandingReadRoot[] {
  const groups: [SandboxReadGroup, string[]][] = []
  if (policy.toolchains)
    groups.push(['toolchains', toolchainReadRootCandidates(env, home, platform)])
  if (policy.caches) groups.push(['caches', cacheReadRootCandidates(env, home, platform)])
  if (groups.length === 0) return []
  const readTarget = createToolchainReadGuard(env, home)
  const roots: StandingReadRoot[] = []
  const seen = new Set<string>()
  for (const [group, candidates] of groups) {
    for (const path of candidates) {
      const canonical = readTarget(path, true)
      if (canonical === null || seen.has(canonical)) continue
      seen.add(canonical)
      roots.push({ group, path: resolve(path), canonical })
    }
  }
  return roots
}

const STANDING_ROOTS_TTL_MS = 2_000
let standingRootsMemo: { key: string; at: number; roots: StandingReadRoot[] } | null = null

/**
 * {@link resolveStandingReadRoots} for the live settings and environment,
 * memoized for a moment: the classifier asks several times per command and
 * every spawn builds an overlay, and each resolution stats a few dozen paths.
 * A switch change takes effect on the next resolution with a different key.
 */
export function currentStandingReadRoots(): StandingReadRoot[] {
  const policy = sandboxReadAccessPolicy()
  const key = JSON.stringify([policy, homedir()])
  const now = Date.now()
  if (standingRootsMemo?.key === key && now - standingRootsMemo.at < STANDING_ROOTS_TTL_MS)
    return standingRootsMemo.roots
  const roots = resolveStandingReadRoots(policy)
  standingRootsMemo = { key, at: now, roots }
  return roots
}

/**
 * Whether `canonical` is Copse's own profile root or inside it: other
 * projects' worktrees, plugins, knowledge and keys live there, so no project
 * may approve a folder in it.
 */
function insideCopseProfile(canonical: string, env: NodeJS.ProcessEnv, home: string): boolean {
  const profileEnv = { ...env }
  if (!env['COPSE_DIR']?.trim()) profileEnv['COPSE_DIR'] = join(home, '.copse')
  const root = resolve(copseDataRoot(profileEnv))
  const spellings = [root]
  try {
    spellings.push(realpathSync(root))
  } catch {
    // A profile root that does not exist yet has only the one spelling.
  }
  return spellings.some(
    (spelling) => canonical === spelling || canonical.startsWith(spelling + sep),
  )
}

/**
 * Re-check an approved folder before a spawn uses it: it must still be a
 * directory at the same canonical path, outside Copse's profile root, and still
 * clear the credential guard. A folder replaced by a link elsewhere, or one
 * that now holds a credential store, silently stops being readable until it is
 * approved again.
 */
export function approvedFolderStillSafe(
  canonical: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  let real: string
  try {
    real = realpathSync(canonical)
  } catch {
    return false
  }
  return (
    real === canonical &&
    !insideCopseProfile(canonical, env, home) &&
    createToolchainReadGuard(env, home)(canonical, true) === canonical
  )
}

/**
 * Leaf names that are credentials by convention, lower-case. A superset of
 * what `sensitiveTargetReason` calls a credential file, matched without regard
 * to case (a test holds the two lists together).
 */
const SECRET_NAME_GLOBS: readonly string[] = [
  ...[...SENSITIVE_BASENAMES].filter((name) => !name.includes('*')),
  '.env',
  '.env.*',
  ...['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'asc', 'p8'].map((ext) => `*.${ext}`),
  'id_*',
  '*secret*',
  '*credential*',
]

/** `.Env` → `.[eE][nN][vV]`: ASRT's seatbelt regexes are case-sensitive, names on disk need not be. */
function caseInsensitiveGlob(glob: string): string {
  return glob.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)
}

function nameGlobRegex(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

const SECRET_NAME_REGEXES = SECRET_NAME_GLOBS.map(nameGlobRegex)

/** Whether a file name is a credential by the approved-folder deny list. */
export function isApprovedFolderSecretName(name: string): boolean {
  return SECRET_NAME_REGEXES.some((regex) => regex.test(name))
}

/** Whether a directory name is a credential store by the approved-folder deny list. */
export function isApprovedFolderSecretDir(name: string): boolean {
  return SENSITIVE_DIR_SEGMENTS.has(name.toLowerCase())
}

/**
 * macOS `denyRead` globs that keep credentials unreadable inside an approved
 * folder. ASRT emits glob denies after its allow block, so seatbelt (last match
 * wins) denies them over the folder's own `/**` allow.
 */
export function approvedFolderSecretDenyEntries(root: string): string[] {
  return [
    ...SECRET_NAME_GLOBS.map((glob) => `${root}/**/${caseInsensitiveGlob(glob)}`),
    ...[...SENSITIVE_DIR_SEGMENTS].map((dir) => `${root}/**/${caseInsensitiveGlob(dir)}/**`),
  ]
}

/** Entries a Linux walk may visit before it gives the folder up (fails closed). */
export const APPROVED_FOLDER_WALK_LIMIT = 200_000
/** Concrete denies one folder may need before it is given up instead. */
export const APPROVED_FOLDER_DENY_LIMIT = 2_000

function isPermissionError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'EACCES' || code === 'EPERM'
}

/**
 * The concrete credential paths inside `root`, for Linux, where bubblewrap
 * takes no globs. ASRT's own expansion returns no paths at all when any
 * directory in the walk is unreadable, so Copse walks the folder itself: an
 * unreadable directory is denied whole and the walk goes on; any other error,
 * or a folder past the walk or deny limit, returns null and the caller drops
 * the folder rather than allow it without its denies. Symlinked directories
 * are not followed (their targets are judged by their own allow and deny).
 * The list is a spawn-time snapshot, as ASRT's was.
 */
export function approvedFolderLinuxDenies(
  root: string,
  limits: { entries: number; denies: number } = {
    entries: APPROVED_FOLDER_WALK_LIMIT,
    denies: APPROVED_FOLDER_DENY_LIMIT,
  },
): string[] | null {
  const denies: string[] = []
  const pending = [root]
  let visited = 0
  while (pending.length > 0) {
    const dir = pending.pop() ?? root
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (dir !== root && isPermissionError(error)) {
        denies.push(dir)
        continue
      }
      return null
    }
    for (const entry of entries) {
      visited += 1
      if (visited > limits.entries) return null
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isApprovedFolderSecretDir(entry.name)) denies.push(path)
        else pending.push(path)
      } else if (isApprovedFolderSecretName(entry.name)) {
        denies.push(path)
      }
      if (denies.length > limits.denies) return null
    }
  }
  return denies
}

export interface ApprovedFolderReadPlan {
  /** Folders the overlay may add to `allowRead`. */
  readable: string[]
  /** Credential denies for those folders, appended after every other deny. */
  deny: string[]
}

/**
 * How the overlay opens approved folders on `platform`: macOS denies by glob,
 * Linux by the paths {@link approvedFolderLinuxDenies} found, and a Linux
 * folder whose walk failed is left out entirely.
 */
export function approvedFolderReadPlan(
  folders: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ApprovedFolderReadPlan {
  if (platform === 'darwin') {
    return { readable: [...folders], deny: folders.flatMap(approvedFolderSecretDenyEntries) }
  }
  const readable: string[] = []
  const deny: string[] = []
  for (const folder of folders) {
    const found = approvedFolderLinuxDenies(folder)
    if (found === null) continue
    readable.push(folder)
    deny.push(...found)
  }
  return { readable, deny }
}
