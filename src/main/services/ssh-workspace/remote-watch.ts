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

function watcherMode(): WatcherMode {
  const mode = getSetting<string>('sshWatcherMode', 'auto')
  return mode === 'poll' || mode === 'off' ? mode : 'auto'
}

export function watchRemoteFile(
  key: string,
  target: RemotePollTarget,
  onChange: RemotePollHandler,
): void {
  const mode = watcherMode()
  if (mode === 'off') return
  if (mode === 'poll') {
    watchRemotePath(key, target, onChange)
    return
  }
  const fallback = (fallbackKey: string): void => {
    watchRemotePath(fallbackKey, target, onChange)
  }
  void tryWatchNative(key, target, onChange, fallback).then((accepted) => {
    if (!accepted) watchRemotePath(key, target, onChange)
  })
}

export function unwatchRemoteFile(key: string): void {
  // A key lives in exactly one backend, but which one can change under
  // fallback; unsubscribing both is idempotent and race-free.
  unwatchNative(key)
  unwatchRemotePath(key)
}

export function stopAllRemoteWatchers(): void {
  stopAllNativeWatchers()
  stopRemoteFilePolling()
}
