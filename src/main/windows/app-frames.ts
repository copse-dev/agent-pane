import type { WebFrameMain } from 'electron'

/**
 * Registry of main frames that belong to windows *we* created (the main window
 * and any pane pop-out windows). IPC guards consult this so a pop-out window can
 * use the same preload API surface as the main window, while still rejecting
 * sub-frames, <webview> guests, and any frame the app did not open.
 *
 * `senderFrame` is set by Electron from the OS/IPC layer — a compromised
 * renderer cannot forge it — so membership here is a sound trust signal.
 */
const trustedFrames = new Set<WebFrameMain>()

export function registerTrustedAppFrame(frame: WebFrameMain): void {
  trustedFrames.add(frame)
}

export function unregisterTrustedAppFrame(frame: WebFrameMain): void {
  trustedFrames.delete(frame)
}

export function isTrustedAppFrame(frame: WebFrameMain | null): boolean {
  return frame != null && trustedFrames.has(frame)
}
