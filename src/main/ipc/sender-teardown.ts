/** The slice of a window's `WebContents` an owner teardown needs. */
export interface TeardownSender {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
}

/**
 * Release what a window owns (`release`) when it goes away, for a resource a
 * handler opened across an `await`.
 *
 * A window that closed while the open was in flight has already emitted
 * `destroyed`, so a listener added now would never run and the resource (a
 * VNC socket and its SSH tunnel, a simulator stream) would stay open until
 * quit: that case releases at once and returns false. Otherwise the listener
 * is added once per window, however many resources it opens; `hooked` is the
 * handler's own record of the windows it has already wired.
 */
export function releaseWhenSenderDestroyed(
  sender: TeardownSender,
  hooked: WeakSet<object>,
  release: () => void,
): boolean {
  if (sender.isDestroyed()) {
    release()
    return false
  }
  if (!hooked.has(sender)) {
    hooked.add(sender)
    sender.once('destroyed', release)
  }
  return true
}
