import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { mkdir, writeFile, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { StorageCleanup } from '../storage-cleanup.ts'

/** Apple storage is shared by every Copse profile belonging to this OS user. */
export function appleContainerActivity(): StorageCleanup {
  const root = join(homedir(), '.copse', 'cache', 'apple-container-activity')
  return new StorageCleanup(root, join(root, 'tmp'))
}

/** Use the same native lock as Copse's image builds; never unlink its inode. */
export async function withAppleBuilderLock<T>(run: () => Promise<T>): Promise<T> {
  const lock = join(
    '/private/tmp',
    `copse-apple-builder-${String(process.getuid?.() ?? 'unknown')}.lock`,
  )
  const child = spawn('/usr/bin/lockf', ['-k', '-t', '0', lock, '/bin/cat'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve()
    })
    child.once('error', () => {
      resolve()
    })
  })
  let acquired = false
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Apple container build storage is busy'))
      }, 5_000)
      const ready = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const failed = (): void => {
        clearTimeout(timer)
        reject(new Error('Apple container build storage is busy'))
      }
      child.stdout.once('data', ready)
      child.once('exit', failed)
      child.once('error', failed)
      child.stdin.on('error', failed)
      child.stdin.write('ready\n')
    })
    acquired = true
    return await run()
  } finally {
    child.stdin.end()
    if (!acquired) child.kill()
    await exited
  }
}

function imageUsagePath(name: string): string {
  return join(
    homedir(),
    '.copse',
    'cache',
    'apple-container-activity',
    'image-use',
    createHash('sha256')
      .update(name.replace(/^docker\.io\/library\//, ''))
      .digest('hex'),
  )
}
export async function markAppleImageUsed(name: string): Promise<void> {
  const path = imageUsagePath(name)
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, '', { mode: 0o600 })
}
export async function appleImageLastUsed(name: string): Promise<number> {
  const stat = await lstat(imageUsagePath(name)).catch((error: unknown) => {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  })
  return stat?.mtimeMs ?? 0
}
