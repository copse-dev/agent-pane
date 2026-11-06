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
  // Each construction is a new policy decision. Reusing filesystem identities
  // from a previous command can miss a newly created or relinked known store.
  const { homes, credentials } = computeProtectedStores([process.env, env], home)
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
  // Reuse a resolution only inside this synchronous policy construction. A
  // cross-command cache can mistake a newly writable link for its old path.
  const canonical = new Map<string, string | null>()
  const canonicalizeGuardPath = (path: string): string | null => {
    const normalized = resolve(path)
    const known = canonical.get(normalized)
    if (known !== undefined) return known
    let target: string | null = null
    try {
      target = realpathSync(normalized)
    } catch {
      // An unresolved exception or crossed-link holder must fail closed.
    }
    canonical.set(normalized, target)
    return target
  }
  const spellings = (path: string): string[] => {
    const target = canonicalizeGuardPath(path)
    return target === null ? [resolve(path)] : [...new Set([resolve(path), target])]
  }
  const concreteOf = (path: string): string => resolve(path.replace(/\/\*\*$/, ''))
  const roots = existingReads.flatMap((path) => spellings(concreteOf(path)))
  const reachable = [...roots, ...writableRoots.flatMap((path) => spellings(concreteOf(path)))]
  const deniedRoots = deniedReads.flatMap((path) => spellings(concreteOf(path)))
  const linksStayDenied = (concrete: string, deniedRoot: string): boolean => {
    const target = canonicalizeGuardPath(concrete)
    if (target === null) return false
    if (target === concrete) return true
    const links = crossedSymlinks(concrete, deniedRoot)
    return (
      links !== null &&
      links.every((link) => {
        const holder = canonicalizeGuardPath(dirname(link))
        return (
          holder !== null &&
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
