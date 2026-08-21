/** Resolve an installed dependency root from the project package.json (cwd). */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'

const requireFromProject = createRequire(join(process.cwd(), 'package.json'))

export function resolveDepPackageJson(packageName: string): string {
  return requireFromProject.resolve(`${packageName}/package.json`)
}

export function resolveDepRoot(packageName: string): string {
  try {
    return dirname(resolveDepPackageJson(packageName))
  } catch (error) {
    // A package whose "exports" map omits "./package.json" — the norm for
    // ESM-only packages — cannot be reached by subpath at all. Resolve its
    // entry point instead and walk up to the directory that declares the name.
    if (!isNotExported(error)) throw error
    return packageRootOf(requireFromProject.resolve(packageName), packageName)
  }
}

function isNotExported(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  )
}

function packageRootOf(entryPoint: string, packageName: string): string {
  const { root } = parse(entryPoint)
  for (let dir = dirname(entryPoint); dir !== root; dir = dirname(dir)) {
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)) continue
    if (manifest.name === packageName) return dir
  }
  throw new Error(`Could not find the package root for ${packageName} above ${entryPoint}`)
}
