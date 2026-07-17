import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * macOS `sockaddr_un.sun_path` is 104 bytes. While binding a ControlMaster
 * socket, OpenSSH briefly appends a random suffix (e.g. `.fUyzwh1gIvt57SO8`),
 * so the stable path must stay well under that limit.
 *
 * Electron userData on macOS (`…/Application Support/copse-panel/…`) is already
 * ~70 chars before the host id — long host ids then fail with:
 *   unix_listener: path "…" too long for Unix domain socket
 */
export const UNIX_DOMAIN_SOCKET_PATH_MAX = 104
/** Observed OpenSSH temp-suffix length while creating the listener. */
export const OPENSSH_CONTROL_PATH_TEMP_SUFFIX_MAX = 20
export const CONTROL_SOCKET_PATH_BUDGET =
  UNIX_DOMAIN_SOCKET_PATH_MAX - OPENSSH_CONTROL_PATH_TEMP_SUFFIX_MAX

let controlDirOverride: string | null = null

/** Test hook: point SSH control sockets at a throwaway directory. */
export function setSshControlDirForTests(dir: string | null): void {
  controlDirOverride = dir
}

function shortControlRoot(): string {
  if (controlDirOverride) return controlDirOverride
  // Prefer `/tmp` on Unix — `os.tmpdir()` on macOS is under `/var/folders/…/T`
  // and can erase most of the path budget by itself.
  if (process.platform === 'win32') {
    return join(tmpdir(), 'copse-ssh')
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return join('/tmp', `copse-ssh-${String(uid)}`)
}

export function sshControlDir(): string {
  const dir = shortControlRoot()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Stable short filename for a host id (avoids long alias names in the path). */
export function controlSocketFileName(hostId: string): string {
  const hash = createHash('sha256').update(hostId).digest('hex').slice(0, 16)
  return `${hash}.sock`
}

export function controlSocketPath(hostId: string): string {
  const path = join(sshControlDir(), controlSocketFileName(hostId))
  if (
    process.platform !== 'win32' &&
    Buffer.byteLength(path, 'utf8') > CONTROL_SOCKET_PATH_BUDGET
  ) {
    throw new Error(
      `SSH control socket path too long (${String(Buffer.byteLength(path, 'utf8'))} > ${String(CONTROL_SOCKET_PATH_BUDGET)}): ${path}`,
    )
  }
  return path
}
