import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

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
  for (const command of ['node', 'npm', 'corepack', 'pnpm', 'yarn']) {
    for (const directory of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(directory, command)
      try {
        accessSync(candidate, constants.X_OK)
        const executable = realpathSync(candidate)
        paths.add(candidate)
        paths.add(join(realpathSync(directory), command))
        paths.add(executable)
        for (const parts of implementations) {
          const suffix = join('node_modules', ...parts)
          if (!executable.endsWith(`/${suffix}`)) continue
          const implementation = executable.slice(0, -join(...parts.slice(1)).length - 1)
          paths.add(implementation)
          paths.add(`${implementation}/**`)
        }
        break
      } catch {
        // Missing, stale, or inaccessible PATH entries are not runtime grants.
      }
    }
  }
  return [...paths]
}
