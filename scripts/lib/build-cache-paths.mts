import { realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'

function cacheRoot(override: string | undefined, name: string, env: NodeJS.ProcessEnv): string {
  const configured = override?.trim()
  return resolve(
    configured !== undefined && configured.length > 0
      ? configured
      : join(copseDataRoot(env), 'cache', name),
  )
}

/** Build artifacts follow the profile unless a dedicated shared cache is selected. */
export function electronDistCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return cacheRoot(env['COPSE_ELECTRON_DIST_CACHE'], 'electron-dist', env)
}

export function gortexCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return cacheRoot(env['COPSE_GORTEX_CACHE'], 'gortex', env)
}

/** A checkout and cache moved together must not retain their old mount point. */
export function cacheLinkTarget(linkPath: string, targetPath: string): string {
  // On Windows, relative() returns an absolute path for different drive letters.
  // Both locations exist when linking. Canonicalize parent aliases (macOS
  // /var -> /private/var, pnpm package symlinks) before calculating the route.
  return relative(realpathSync(dirname(linkPath)), realpathSync(targetPath)) || '.'
}
