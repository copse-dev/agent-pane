import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve the bundled `copse-remote-watcher` binary (native/remote-watcher)
 * for a remote host's platform.
 *
 * The remote's platform, not the local one: the binary is uploaded over SSH
 * and runs on the workspace host, so selection keys off the capability
 * probe's `uname -s` / `uname -m`, mapped to the Rust target triples the CI
 * lane builds. A platform with no bundled build resolves to null and the
 * caller stays on the polling floor.
 */

const WATCHER_BIN = 'copse-remote-watcher'

export function remoteWatcherTargetFor(os: string, arch: string): string | null {
  const normalizedArch = arch.toLowerCase()
  if (os === 'Linux') {
    if (normalizedArch === 'x86_64' || normalizedArch === 'amd64') {
      return 'x86_64-unknown-linux-musl'
    }
    if (normalizedArch === 'aarch64' || normalizedArch === 'arm64') {
      return 'aarch64-unknown-linux-musl'
    }
    return null
  }
  if (os === 'Darwin') {
    if (normalizedArch === 'arm64' || normalizedArch === 'aarch64') {
      return 'aarch64-apple-darwin'
    }
    if (normalizedArch === 'x86_64') return 'x86_64-apple-darwin'
    return null
  }
  return null
}

/** Bundled binary for the remote platform, or null when not shipped/built. */
export function getBundledRemoteWatcherPath(os: string, arch: string): string | null {
  const target = remoteWatcherTargetFor(os, arch)
  if (!target) return null
  return firstAccessible([
    join(__dirname, '../resources/remote-watcher', target, WATCHER_BIN),
    join(__dirname, '../../vendor/remote-watcher', target, WATCHER_BIN),
  ])
}

function firstAccessible(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}
