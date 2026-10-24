import { accessSync, constants, realpathSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'

const NODE_TOOLCHAIN_COMMANDS = ['node', 'npm', 'corepack', 'pnpm', 'yarn']

/**
 * A version manager whose PATH entry is a shim directory. The shim execs the
 * selected install, so a grant for the shim file alone leaves `node` unable to
 * start. `reads` names the subtrees of the manager's data root the shim needs;
 * the root itself is never granted.
 */
interface ShimManager {
  root: (env: NodeJS.ProcessEnv, home: string) => string | null
  shims: string
  reads: readonly string[]
}

/** An override variable's value when absolute, the default when unset, else null. */
function managerRoot(value: string | undefined, fallback: string): string | null {
  if (value === undefined || value === '') return fallback
  return isAbsolute(value) ? value : null
}

const SHIM_MANAGERS: readonly ShimManager[] = [
  // `bin/node` links to `bin/volta-shim`, which runs `tools/image/node/<version>/bin/node`.
  {
    root: (env, home) => managerRoot(env['VOLTA_HOME'], join(home, '.volta')),
    shims: 'bin',
    reads: ['bin', 'tools'],
  },
  // `shims/node` is a script running `asdf exec`; a git install keeps asdf's own bin and lib here.
  {
    root: (env, home) => managerRoot(env['ASDF_DATA_DIR'], join(home, '.asdf')),
    shims: 'shims',
    reads: ['shims', 'installs', 'plugins', 'bin', 'lib'],
  },
  // `shims/node` links to the mise binary, which runs `installs/node/<version>/bin/node`.
  {
    root: (env, home): string | null => {
      const dataHome = managerRoot(env['XDG_DATA_HOME'], join(home, '.local', 'share'))
      return managerRoot(
        env['MISE_DATA_DIR'],
        join(dataHome ?? join(home, '.local', 'share'), 'mise'),
      )
    },
    shims: 'shims',
    reads: ['shims', 'installs', 'plugins'],
  },
]

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** A directory's path and canonical spelling, or nothing when it is not a directory. */
function directorySpellings(path: string): string[] {
  try {
    if (!statSync(path).isDirectory()) return []
    return [...new Set([path, realpathSync(path)])]
  } catch {
    return []
  }
}

/**
 * Read grants for the install trees behind a version-manager shim on PATH.
 * Only a resolved command whose PATH directory is that manager's own shim
 * directory earns them, and a manager rooted at or above home earns none.
 */
function shimManagerReadPaths(
  resolved: readonly ResolvedToolchainCommand[],
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const paths: string[] = []
  const directories = new Set(
    resolved.flatMap(({ candidate, canonicalCandidate }) => [
      dirname(candidate),
      dirname(canonicalCandidate),
    ]),
  )
  for (const manager of SHIM_MANAGERS) {
    const root = manager.root(env, home)
    if (root === null || isWithin(root, home)) continue
    const shims = directorySpellings(join(root, manager.shims))
    if (!shims.some((directory) => directories.has(directory))) continue
    for (const subtree of manager.reads) {
      for (const path of directorySpellings(join(root, subtree))) paths.push(path, `${path}/**`)
    }
  }
  return paths
}

/** Keep PATH ordering while removing directory aliases that Seatbelt cannot traverse. */
export function preparationPathEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = (env['PATH'] ?? '')
    .split(delimiter)
    .map((directory) => {
      if (!isAbsolute(directory)) return directory
      try {
        return realpathSync(directory)
      } catch {
        return directory
      }
    })
    .join(delimiter)
  return { ...env, PATH: path }
}

interface ResolvedToolchainCommand {
  command: string
  /** The PATH spelling, as the shell finds it. */
  candidate: string
  /** The same spelling with its PATH directory canonicalized. */
  canonicalCandidate: string
  /** The canonical executable after following every symlink. */
  executable: string
}

/** The first executable PATH match for each Node toolchain command. */
function resolveNodeToolchain(env: NodeJS.ProcessEnv): ResolvedToolchainCommand[] {
  const resolved: ResolvedToolchainCommand[] = []
  for (const command of NODE_TOOLCHAIN_COMMANDS) {
    for (const directory of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(directory, command)
      try {
        accessSync(candidate, constants.X_OK)
        resolved.push({
          command,
          candidate,
          canonicalCandidate: join(realpathSync(directory), command),
          executable: realpathSync(candidate),
        })
        break
      } catch {
        // Missing, stale, or inaccessible PATH entries are not runtime grants.
      }
    }
  }
  return resolved
}

/**
 * Resolve the actual executables, including fnm's directory symlink and the
 * npm/Corepack file symlinks beneath it. Seatbelt checks canonical paths: a
 * grant for the lexical multishell directory does not grant its installation.
 *
 * Grant only executable files, recognized package-manager implementation trees,
 * and the install trees behind a recognized version-manager shim (Volta, asdf,
 * mise). Never infer a recursive grant from the parent of a PATH entry (which
 * could be HOME, a multishell registry, or a directory of unrelated programs).
 */
export function preparationNodeToolchainReadPaths(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string[] {
  const paths = new Set<string>()
  const resolved = resolveNodeToolchain(env)
  const implementations = [
    ['npm', 'bin', 'npm-cli.js'],
    ['corepack', 'dist', 'corepack.js'],
    ['corepack', 'dist', 'pnpm.js'],
    ['corepack', 'dist', 'yarn.js'],
    ['pnpm', 'bin', 'pnpm.cjs'],
    ['yarn', 'bin', 'yarn.js'],
  ]
  for (const { candidate, canonicalCandidate, executable } of resolved) {
    paths.add(candidate)
    paths.add(canonicalCandidate)
    paths.add(executable)
    for (const parts of implementations) {
      const suffix = join('node_modules', ...parts)
      if (!executable.endsWith(`/${suffix}`)) continue
      const implementation = executable.slice(0, -join(...parts.slice(1)).length - 1)
      paths.add(implementation)
      paths.add(`${implementation}/**`)
    }
  }
  for (const path of shimManagerReadPaths(resolved, env, home)) paths.add(path)
  return [...paths]
}

/**
 * Put symlinks to the canonical toolchain executables first on PATH.
 *
 * bubblewrap re-exposes a granted file by bind-mounting it, and the bind
 * follows its source symlink: fnm's `bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js`
 * becomes a plain copy of the CLI at `bin/npm`. Node then resolves the CLI's
 * relative requires from `bin/`, so npm and Corepack cannot start. Granting
 * the whole `bin` directory would keep its symlinks but also expose every
 * other program beside them. `directory` must sit inside a writable grant
 * (bound as a directory, so these symlinks survive) and belong to one
 * contained process.
 */
export function linkPreparationNodeToolchain(
  env: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv {
  const resolved = resolveNodeToolchain(env)
  if (resolved.length === 0) return env
  for (const { command, executable } of resolved) {
    symlinkSync(executable, join(directory, command))
  }
  return { ...env, PATH: `${directory}${delimiter}${env['PATH'] ?? ''}` }
}
