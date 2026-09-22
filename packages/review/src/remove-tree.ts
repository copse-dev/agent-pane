import { chmod, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

function ownErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return undefined
  return Object.getOwnPropertyDescriptor(error, 'code')?.value
}

async function makeDirectoriesWritable(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (ownErrorCode(error) === 'ENOENT') return null
    throw error
  })
  // Never follow a symlink an untrusted command left in the scratch tree.
  if (info === null || !info.isDirectory()) return

  await chmod(path, info.mode | 0o700)
  const entries = await readdir(path, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => makeDirectoriesWritable(join(path, entry.name))),
  )
}

/** Remove a scratch tree even when a tool made cache directories read-only. */
export async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error: unknown) {
    const code = ownErrorCode(error)
    if (code !== 'EACCES' && code !== 'EPERM') throw error
    await makeDirectoriesWritable(path)
    await rm(path, { recursive: true, force: true })
  }
}
