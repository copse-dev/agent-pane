import { promises as fs } from 'node:fs'
import { join } from 'node:path'

function ownErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return undefined
  return Object.getOwnPropertyDescriptor(error, 'code')?.value
}

function pathDisappeared(error: unknown): boolean {
  const code = ownErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function makeDirectoriesWritable(path: string): Promise<void> {
  const info = await fs.lstat(path).catch((error: unknown) => {
    if (pathDisappeared(error)) return null
    throw error
  })
  // Never follow a symlink an untrusted command left in the scratch tree.
  if (info === null || !info.isDirectory()) return

  try {
    await fs.chmod(path, info.mode | 0o700)
  } catch (error: unknown) {
    // Test runners and other tools may remove their own temporary directories
    // after their parent process exits. Vanishing during cleanup is success.
    if (pathDisappeared(error)) return
    throw error
  }
  const entries = await fs.readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (pathDisappeared(error)) return null
    throw error
  })
  if (entries === null) return
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => makeDirectoriesWritable(join(path, entry.name))),
  )
}

/** Remove a scratch tree even when a tool made cache directories read-only. */
export async function removeTree(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  } catch (error: unknown) {
    const code = ownErrorCode(error)
    if (code !== 'EACCES' && code !== 'EPERM') throw error
    await makeDirectoriesWritable(path)
    await fs.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  }
}
