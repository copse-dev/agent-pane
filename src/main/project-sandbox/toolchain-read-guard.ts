import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function spellings(path: string): string[] {
  try {
    return [...new Set([resolve(path), realpathSync(path)])]
  } catch {
    return [resolve(path)]
  }
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
  const homes = spellings(home)
  const protectedPaths = homes.flatMap((root) =>
    HOME_CREDENTIAL_PATHS.map((path) => join(root, path)),
  )
  for (const source of [process.env, env]) {
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
  const credentials = [...new Set(protectedPaths.flatMap(spellings))]
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

/** Omit unnecessary exceptions, including mutable files inside the workspace. */
export function toolchainReadExceptions(
  paths: readonly string[],
  deniedReads: readonly string[],
  existingReads: readonly string[],
): string[] {
  const roots = existingReads.flatMap((path) => spellings(path.replace(/\/\*\*$/, '')))
  const deniedRoots = deniedReads.flatMap((path) => spellings(path.replace(/\/\*\*$/, '')))
  return paths.filter((path) => {
    const concrete = path.replace(/\/\*\*$/, '')
    return (
      deniedRoots.some((root) => isWithin(root, concrete)) &&
      !roots.some((root) => isWithin(root, concrete))
    )
  })
}
