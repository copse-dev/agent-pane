import { existsSync, rmSync } from 'node:fs'

/** Remove prior output before callers continue or fail because a source is missing. */
export function removeMissingBuildArtifact(source: string, destination: string): boolean {
  if (existsSync(source)) return false
  rmSync(destination, { recursive: true, force: true })
  return true
}
