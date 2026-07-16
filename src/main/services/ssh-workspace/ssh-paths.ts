import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let userDataDirOverride: string | null = null

/** Test hook: point SSH control sockets at a throwaway directory. */
export function setSshPathsUserDataDirForTests(dir: string | null): void {
  userDataDirOverride = dir
}

function userDataDir(): string {
  if (userDataDirOverride) return userDataDirOverride
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (typeof app.getPath === 'function') return app.getPath('userData')
  } catch {
    // fall through
  }
  return join(tmpdir(), 'copse-ssh-workspace')
}

export function sshControlDir(): string {
  const dir = join(userDataDir(), 'ssh')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function controlSocketPath(hostId: string): string {
  return join(sshControlDir(), `${hostId}.sock`)
}
