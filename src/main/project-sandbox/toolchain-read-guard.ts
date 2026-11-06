import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  SENSITIVE_BASENAMES,
  SENSITIVE_DIR_SEGMENTS,
  SENSITIVE_PATH_FRAGMENTS,
  sensitiveTargetReason,
} from '@copse/shell-guard/read-outside-project.ts'
import {
  copseDataRoot,
  copseUserDataDir,
  copseWorkspaceDir,
} from '../services/storage/copse-paths.ts'
import { createCanonicalPathCache } from './canonical-path-cache.ts'

const HOME_CREDENTIAL_PATHS = [
  ...SENSITIVE_BASENAMES,
  ...SENSITIVE_DIR_SEGMENTS,
  ...SENSITIVE_PATH_FRAGMENTS.map((fragment) => fragment.slice(1, -1)),
  'Library/Keychains',
  '.codex',
  '.claude',
  '.yarnrc.yml',
  '.config/pnpm/rc',
  '.config/git/credentials',
  '.bunfig.toml',
  '.config/uv',
  '.pypirc',
  '.config/pip',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.cargo/config',
  '.cargo/config.toml',
]

/** Known tools' explicit credential/config locations; never inferred from arbitrary env keys. */
const CREDENTIAL_LOCATION_ENV = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'GH_CONFIG_DIR',
  'DOCKER_CONFIG',
  'GNUPGHOME',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_CONFIG',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_userconfig',
  'PIP_CONFIG_FILE',
]

/**
 * Whether `child` is `parent` or inside it. Both must already be resolved
 * (absolute, normalized): every caller passes `resolve`d or `realpath`ed
 * spellings, so a prefix test answers what `relative` would at a fraction of
 * its cost. The guard runs a few hundred of these per sandboxed spawn.
 */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/**
 * Canonical spellings of the sandbox's read, write and deny roots and of the
 * links an exception crosses, memoized with the same short TTL as
 * `canonicalizePathCached`. A separate instance, so the forty-odd roots each
 * overlay checks do not evict the rule paths the shared cache holds.
 */
const canonicalizeGuardPath = createCanonicalPathCache({ maxEntries: 512 })

function spellings(path: string): string[] {
  return [...new Set([resolve(path), canonicalizeGuardPath(path)])]
}

/**
 * The symlinks a lookup of `path` crosses below `root`, outermost first,
 * including `path` itself when it is one. Null when any of those components
 * cannot be inspected (the lookup would fail anyway; callers grant nothing).
 * `path` must be inside `root`.
 */
export function crossedSymlinks(path: string, root: string): string[] | null {
  const links: string[] = []
  const stop = resolve(root)
  for (let current = resolve(path); current !== stop; current = dirname(current)) {
    if (!isWithin(stop, current)) return null
    try {
      if (lstatSync(current).isSymbolicLink()) links.unshift(current)
    } catch {
      return null
    }
  }
  return links
}

/**
 * Every variable the protected-store list reads. It sees only these, through
 * {@link pickStoreEnv}, so they also form a complete memo key.
 */
const PROTECTED_STORE_ENV = [
  'XDG_CONFIG_HOME',
  ...CREDENTIAL_LOCATION_ENV,
  'KUBECONFIG',
  'CARGO_HOME',
  'COPSE_DIR',
  'COPSE_PANEL_USER_DATA',
  'COPSE_WORKSPACE_DIR',
]

function pickStoreEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {}
  for (const name of PROTECTED_STORE_ENV) {
    const value = source[name]
    if (value !== undefined) picked[name] = value
  }
  return picked
}

interface ProtectedStores {
  /** Every spelling of home. */
  readonly homes: readonly string[]
  /** Every spelling of each known credential store and Copse profile store. */
  readonly credentials: readonly string[]
}

function freshSpellings(path: string): string[] {
  try {
    return [...new Set([resolve(path), realpathSync(path)])]
  } catch {
    return [resolve(path)]
  }
}

function computeProtectedStores(
  sources: readonly NodeJS.ProcessEnv[],
  home: string,
): ProtectedStores {
  const homes = freshSpellings(home)
  const protectedPaths = homes.flatMap((root) =>
    HOME_CREDENTIAL_PATHS.map((path) => join(root, path)),
  )
  for (const source of sources) {
    const configHome = source['XDG_CONFIG_HOME']
    if (configHome && isAbsolute(configHome))
      protectedPaths.push(
        ...HOME_CREDENTIAL_PATHS.filter((path) => path.startsWith('.config/')).map((path) =>
          join(configHome, path.slice('.config/'.length)),
        ),
      )
    for (const variable of CREDENTIAL_LOCATION_ENV) {
      const path = source[variable]
      if (path && isAbsolute(path)) protectedPaths.push(path)
    }
    // kubectl supports several config files, separated by the host PATH delimiter.
    for (const path of source['KUBECONFIG']?.split(delimiter) ?? []) {
      if (isAbsolute(path)) protectedPaths.push(path)
    }
    const cargoHome = source['CARGO_HOME']
    if (cargoHome && isAbsolute(cargoHome))
      protectedPaths.push(
        ...['credentials', 'credentials.toml', 'config', 'config.toml'].map((name) =>
          join(cargoHome, name),
        ),
      )
    const profileEnv = { ...source }
    if (!source['COPSE_DIR']?.trim()) profileEnv['COPSE_DIR'] = join(home, '.copse')
    protectedPaths.push(
      copseUserDataDir(profileEnv),
      copseWorkspaceDir(profileEnv),
      join(copseDataRoot(profileEnv), 'lan'),
    )
  }
  return { homes, credentials: [...new Set(protectedPaths.flatMap(freshSpellings))] }
}

/**
 * The protected-store list, rebuilt at most once per {@link PROTECTED_STORES_TTL_MS}
 * for the same home and store variables. Every sandboxed spawn builds a guard
 * (about ten a second during an agent turn) and the list canonicalizes well
 * over a hundred mostly-missing paths, so rebuilding it each time multiplied
 * the overlay's cost. The window matches `canonicalizePathCached`: a store
 * created or relinked later is protected once it expires.
 */
const PROTECTED_STORES_TTL_MS = 2_000
const PROTECTED_STORES_MAX_ENTRIES = 16
const protectedStoresMemo = new Map<
  string,
  { readonly stores: ProtectedStores; readonly expiresAt: number }
>()

function protectedStores(env: NodeJS.ProcessEnv, home: string): ProtectedStores {
  const sources = [pickStoreEnv(process.env), pickStoreEnv(env)]
  const key = JSON.stringify([home, sources])
  const now = Date.now()
  const hit = protectedStoresMemo.get(key)
  if (hit && hit.expiresAt > now) return hit.stores
  const stores = computeProtectedStores(sources, home)
  protectedStoresMemo.delete(key)
  protectedStoresMemo.set(key, { stores, expiresAt: now + PROTECTED_STORES_TTL_MS })
  if (protectedStoresMemo.size > PROTECTED_STORES_MAX_ENTRIES) {
    const oldest = protectedStoresMemo.keys().next()
    if (!oldest.done) protectedStoresMemo.delete(oldest.value)
  }
  return stores
}

export type ToolchainReadGuard = (path: string, recursive: boolean) => string | null

/**
 * Resolve bounded automatic toolchain reads against the known credential stores.
 * The returned path is canonical, so replacing the original alias does not
 * redirect a later ASRT normalization. This is a point-in-time check: replacing
 * the canonical path or its ancestors before profile construction still races.
 * Contents of a permitted install/cache remain readable; this does not discover
 * arbitrary secret files.
 */
export function createToolchainReadGuard(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ToolchainReadGuard {
  const { homes, credentials } = protectedStores(env, home)
  return (path, recursive) => {
    if (!isAbsolute(path)) return null
    let canonical: string
    try {
      canonical = realpathSync(path)
      const info = statSync(canonical)
      if (recursive ? !info.isDirectory() : !info.isFile()) return null
    } catch {
      return null
    }
    const suffix = recursive ? '/' : ''
    for (const candidate of [resolve(path), canonical]) {
      if (
        ['*', '?', '[', ']', '{', '}'].some((part) => candidate.includes(part)) ||
        sensitiveTargetReason(candidate, `${candidate}${suffix}`) !== null ||
        homes.some((root) => isWithin(candidate, root)) ||
        credentials.some(
          (credential) => isWithin(candidate, credential) || isWithin(credential, candidate),
        )
      )
        return null
    }
    return canonical
  }
}

/**
 * Omit unnecessary exceptions, including mutable files inside the workspace.
 *
 * An exception spelled through a symlink (an fnm multishell, a relocated
 * version manager) is re-resolved when the sandbox is built, so it is kept
 * only while every symlink it crosses inside the denied region really lives
 * there, outside each root the sandbox can read or write. A contained command
 * then has no way to retarget the link between this check and the mount. The
 * check is point-in-time like the rest of the guard.
 */
export function toolchainReadExceptions(
  paths: readonly string[],
  deniedReads: readonly string[],
  existingReads: readonly string[],
  writableRoots: readonly string[] = [],
): string[] {
  const concreteOf = (path: string): string => resolve(path.replace(/\/\*\*$/, ''))
  const roots = existingReads.flatMap((path) => spellings(concreteOf(path)))
  const reachable = [...roots, ...writableRoots.flatMap((path) => spellings(concreteOf(path)))]
  const deniedRoots = deniedReads.flatMap((path) => spellings(concreteOf(path)))
  const linksStayDenied = (concrete: string, deniedRoot: string): boolean => {
    if (canonicalizeGuardPath(concrete) === concrete) return true
    const links = crossedSymlinks(concrete, deniedRoot)
    return (
      links !== null &&
      links.every((link) => {
        const holder = canonicalizeGuardPath(dirname(link))
        return (
          deniedRoots.some((root) => isWithin(root, holder)) &&
          !reachable.some((root) => isWithin(root, holder))
        )
      })
    )
  }
  return paths.filter((path) => {
    const concrete = concreteOf(path)
    // The outermost denied root, so every link below the deny is checked.
    const deniedRoot = deniedRoots
      .filter((root) => isWithin(root, concrete))
      .sort((a, b) => a.length - b.length)[0]
    return (
      deniedRoot !== undefined &&
      !roots.some((root) => isWithin(root, concrete)) &&
      linksStayDenied(concrete, deniedRoot)
    )
  })
}
