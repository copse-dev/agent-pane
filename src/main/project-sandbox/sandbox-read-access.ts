import { readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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
          join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
          join(home, 'Library', 'Logs', 'DiagnosticReports'),
          '/Library/Logs/DiagnosticReports',
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
 * Re-check an approved folder before a spawn uses it: it must still be a
 * directory at the same canonical path, and still clear the credential guard.
 * A folder replaced by a link elsewhere, or one that now holds a credential
 * store, silently stops being readable until it is approved again.
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
  return real === canonical && createToolchainReadGuard(env, home)(canonical, true) === canonical
}

/** Leaf names that are credentials by convention, as seatbelt globs. */
const SECRET_FILE_GLOBS = [
  ...[...SENSITIVE_BASENAMES].filter((name) => !name.includes('*')),
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.ppk',
  'id_*',
  '*secret*',
  '*credential*',
]

/**
 * `denyRead` entries that keep credentials unreadable inside an approved
 * folder. ASRT emits glob denies after its allow block, so they win over the
 * folder's own `/**` allow; on Linux it expands them to the files that exist
 * at spawn time.
 */
export function approvedFolderSecretDenyEntries(root: string): string[] {
  return [
    ...SECRET_FILE_GLOBS.map((glob) => `${root}/**/${glob}`),
    ...[...SENSITIVE_DIR_SEGMENTS].map((dir) => `${root}/**/${dir}/**`),
  ]
}
