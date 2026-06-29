/** Isolated session for the visible in-app browser pane (webview / BrowserView guests). */
export const BROWSER_SESSION_PARTITION = 'persist:copse-browser'

/**
 * Separate isolated session for agent-driven browser automation (#467). Kept
 * distinct from the user's interactive browser pane so the agent gets its own
 * profile and never inherits cookies/logins the user established by hand.
 */
export const BROWSER_AGENT_SESSION_PARTITION = 'persist:copse-browser-agent'

/** True for either of the isolated in-app browser partitions (pane or agent). */
export function isBrowserSessionPartition(partition: string): boolean {
  return partition === BROWSER_SESSION_PARTITION || partition === BROWSER_AGENT_SESSION_PARTITION
}
