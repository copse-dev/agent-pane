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
  return [BROWSER_SESSION_PARTITION, BROWSER_AGENT_SESSION_PARTITION].some(
    (base) => partition === base || partition.startsWith(`${base}:thread:`),
  )
}

/** Stable ownership shared by the pane and automation, with separate cookie jars. */
export function browserThreadScope(projectId: string | null, threadId: string | null): string {
  return projectId && threadId
    ? `thread:${encodeURIComponent(JSON.stringify([projectId, threadId]))}`
    : ''
}

export function browserSessionPartition(base: string, scope: string): string {
  return scope ? `${base}:${scope}` : base
}

/** Interactive UI routes can share visible profiles, including saved legacy panes. */
export function isVisibleBrowserSessionPartition(partition: string): boolean {
  return partition === BROWSER_SESSION_PARTITION || visibleBrowserThread(partition) !== null
}

/** Task plugin routes may only operate the visible cookie jar owned by that task. */
export function isVisibleBrowserSessionForThread(partition: string, threadId: string): boolean {
  return threadId.length > 0 && visibleBrowserThread(partition) === threadId
}

function visibleBrowserThread(partition: string): string | null {
  const prefix = `${BROWSER_SESSION_PARTITION}:thread:`
  if (!partition.startsWith(prefix)) return null
  try {
    const owner: unknown = JSON.parse(decodeURIComponent(partition.slice(prefix.length)))
    return Array.isArray(owner) &&
      owner.length === 2 &&
      typeof owner[0] === 'string' &&
      owner[0].length > 0 &&
      typeof owner[1] === 'string' &&
      owner[1].length > 0
      ? owner[1]
      : null
  } catch {
    return null
  }
}
