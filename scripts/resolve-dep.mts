/** Resolve an installed dependency root from the project package.json (cwd). */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const requireFromProject = createRequire(join(process.cwd(), 'package.json'))

export function resolveDepPackageJson(packageName: string): string {
  return requireFromProject.resolve(`${packageName}/package.json`)
}

export function resolveDepRoot(packageName: string): string {
  return dirname(resolveDepPackageJson(packageName))
}
