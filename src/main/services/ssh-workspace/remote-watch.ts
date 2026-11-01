import { getSetting } from '../storage/settings.ts'
import {
  stopRemoteFilePolling,
  unwatchRemotePath,
  watchRemotePath,
  type RemotePollHandler,
  type RemotePollTarget,
} from './remote-file-poller.ts'
import { stopAllNativeWatchers, tryWatchNative, unwatchNative } from './remote-native-watcher.ts'

/**
 * The single entry point fs-watcher.ts uses for remote subscriptions: picks a
 * backend per the `sshWatcherMode` setting and keeps the two backends
 * interchangeable behind one subscribe/unsubscribe surface.
 *
 * - `auto` (default): streaming watcher via the uploaded binary, degrading to
 *   polling whenever the native path cannot serve a key — no bundled binary
 *   for the platform, install declined, a `watch-failed` for the path, or a
 *   session death mid-flight.
 * - `poll`: polling only; never uploads or executes anything on the host.
 * - `off`: external-edit detection disabled entirely.
 */

type WatcherMode = 'auto' | 'poll' | 'off'

type NativeWatch = typeof tryWatchNative

let nativeWatch: NativeWatch = tryWatchNative
const requested = new Map<string, symbol>()

/** Test hook for holding native setup in flight. */
export function setRemoteWatchNativeForTest(fn: NativeWatch | null): void {
  nativeWatch = fn ?? tryWatchNative
}

function watcherMode(): WatcherMode {
  const mode = getSetting<string>('sshWatcherMode', 'auto')
  return mode === 'poll' || mode === 'off' ? mode : 'auto'
}

export function watchRemoteFile(
  key: string,
  target: RemotePollTarget,
  onChange: RemotePollHandler,
): void {
  if (requested.has(key)) return
  const mode = watcherMode()
  if (mode === 'off') return
  const token = Symbol(key)
  requested.set(key, token)
  if (mode === 'poll') {
    watchRemotePath(key, target, onChange)
    return
  }

  // Keep the polling floor active while the native binary is approved,
  // uploaded, verified, and announces readiness. That setup can take seconds;
  // without this, external edits made in the window are silently missed.
  watchRemotePath(key, target, onChange)
  const stillRequested = (): boolean => requested.get(key) === token
  const fallback = (fallbackKey: string): void => {
    if (!stillRequested()) return
    watchRemotePath(fallbackKey, target, onChange)
  }
  const nativeReady = (readyKey: string): void => {
    if (stillRequested() && readyKey === key) unwatchRemotePath(key)
  }
  void nativeWatch(key, target, onChange, fallback, stillRequested, nativeReady).catch(
    (err: unknown) => {
      // Polling was installed before native setup began, so an unexpected
      // implementation/transport failure is noisy but does not create a blind
      // spot or an unhandled rejection in the Electron main process.
      console.warn('[copse-panel] remote native watch failed for', target.hostId, err)
    },
  )
}

export function unwatchRemoteFile(key: string): void {
  // A key lives in exactly one backend, but which one can change under
  // fallback; unsubscribing both is idempotent and race-free.
  requested.delete(key)
  unwatchNative(key)
  unwatchRemotePath(key)
}

export function stopAllRemoteWatchers(): void {
  requested.clear()
  stopAllNativeWatchers()
  stopRemoteFilePolling()
}
