import { accessSync, constants, realpathSync, symlinkSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const NODE_TOOLCHAIN_COMMANDS = ['node', 'npm', 'corepack', 'pnpm', 'yarn']

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
 * Grant only executable files and recognized package-manager implementation
 * trees. Never infer a recursive grant from the parent of a PATH entry (which
 * could be HOME, a multishell registry, or a directory of unrelated programs).
 */
export function preparationNodeToolchainReadPaths(env: NodeJS.ProcessEnv): string[] {
  const paths = new Set<string>()
  const implementations = [
    ['npm', 'bin', 'npm-cli.js'],
    ['corepack', 'dist', 'corepack.js'],
    ['corepack', 'dist', 'pnpm.js'],
    ['corepack', 'dist', 'yarn.js'],
    ['pnpm', 'bin', 'pnpm.cjs'],
    ['yarn', 'bin', 'yarn.js'],
  ]
  for (const { candidate, canonicalCandidate, executable } of resolveNodeToolchain(env)) {
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
