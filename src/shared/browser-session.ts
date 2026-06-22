/** Isolated session for in-app browser tabs (webview / BrowserView guests). */
export const BROWSER_SESSION_PARTITION = 'persist:copse-browser'

export function isBrowserSessionPartition(partition: string): boolean {
  return partition === BROWSER_SESSION_PARTITION
}
