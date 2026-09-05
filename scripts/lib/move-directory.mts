import { randomBytes } from 'node:crypto'
import { cpSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface DirectoryMoveOperations {
  rename(source: string, target: string): void
  copy(source: string, target: string): void
  remove(path: string): void
  stagingPath(target: string): string
}

const defaultOperations: DirectoryMoveOperations = {
  rename: renameSync,
  copy: (source, target) => {
    cpSync(source, target, { recursive: true })
  },
  remove: (path) => {
    rmSync(path, { recursive: true, force: true })
  },
  stagingPath: (target) =>
    join(
      dirname(target),
      `.${basename(target)}-copy-${String(process.pid)}-${randomBytes(6).toString('hex')}`,
    ),
}

function isCrossDeviceError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EXDEV'
}

/**
 * Move a directory, falling back to an atomic destination-side copy when the
 * source and target are on different filesystems.
 *
 * The copy lands beside the target and is renamed into place only after it is
 * complete. The source is removed last, so a failed or interrupted copy remains
 * recoverable and cannot look like a complete cache entry.
 */
export function moveDirectory(
  source: string,
  target: string,
  operations: DirectoryMoveOperations = defaultOperations,
): 'moved' | 'copied' {
  try {
    operations.rename(source, target)
    return 'moved'
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error
  }

  const staging = operations.stagingPath(target)
  try {
    operations.copy(source, staging)
    operations.rename(staging, target)
    operations.remove(source)
    return 'copied'
  } finally {
    operations.remove(staging)
  }
}
