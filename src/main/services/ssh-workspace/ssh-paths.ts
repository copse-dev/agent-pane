import { sha256Hex } from '@copse/std/sha256.ts'
import fs, { type Stats } from 'node:fs'
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

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

function shortControlRoot(): string {
  if (controlDirOverride) return controlDirOverride
  // Prefer `/tmp` on Unix — `os.tmpdir()` on macOS is under `/var/folders/…/T`
  // and can erase most of the path budget by itself.
  if (process.platform === 'win32') {
    return join(tmpdir(), 'copse-ssh')
  }
  return join('/tmp', `copse-ssh-${String(currentUid())}`)
}

/**
 * Why an existing control directory must not hold ControlMaster sockets, and
 * what the user can do about it, or `null` when it is a private directory of
 * the current user.
 *
 * The directory sits in a shared temp root, and `mkdir`'s mode applies only
 * when `mkdir` creates the directory, so an existing path is checked with
 * `lstat`: a symbolic link is refused, never followed.
 */
export function controlDirProblem(
  stats: Pick<Stats, 'isSymbolicLink' | 'isDirectory' | 'uid' | 'mode'>,
  uid: number,
): string | null {
  // Checked first: in a sticky temp root only the owner (or an administrator)
  // can remove the entry, so "remove it" is advice this user cannot follow.
  if (stats.uid !== uid) {
    return (
      `it belongs to another account (uid ${String(stats.uid)}, not ${String(uid)}). ` +
      'Only that account or an administrator can remove it; on most systems a restart also clears it.'
    )
  }
  const removeIt = 'Remove it and try again.'
  if (stats.isSymbolicLink()) return `it is a symbolic link. ${removeIt}`
  if (!stats.isDirectory()) return `it is not a directory. ${removeIt}`
  const mode = stats.mode & 0o777
  if (mode !== 0o700) return `its mode is ${mode.toString(8)}, not 700. ${removeIt}`
  return null
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

export function sshControlDir(): string {
  const dir = shortControlRoot()
  if (process.platform === 'win32') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }
  try {
    // Not recursive, so an existing entry of any kind is left as it is.
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    // Already there: made by an earlier run, by another Copse process of the
    // same user a moment ago, or by someone else. The check below decides.
    if (!isAlreadyExists(error)) throw error
  }
  const problem = controlDirProblem(fs.lstatSync(dir), currentUid())
  if (problem !== null) {
    throw new Error(`Refusing to use SSH control directory ${dir}: ${problem}`)
  }
  return dir
}

/** Stable short filename for a host id (avoids long alias names in the path). */
export function controlSocketFileName(hostId: string): string {
  const hash = sha256Hex(hostId).slice(0, 16)
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
