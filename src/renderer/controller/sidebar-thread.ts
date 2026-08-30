import type { Message, Thread } from '@shared/types'
import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import { collectThreadPrRefs } from '@shared/git/thread-pr-status.ts'

/**
 * Everything the projects sidebar reads off a thread to draw one row: its title,
 * its running mark, and the PR-status chip. A live {@link Thread} satisfies this
 * structurally, so the sidebar can be handed either one.
 *
 * The distinction matters because the sidebar keeps a thread list per project
 * visited this session, and those lists used to be whole `Thread`s — every
 * message, tool result and base64 image of every project you had opened, held
 * for a sidebar row that shows a title and a dot. Only one consumer ever touched
 * the transcript ({@link collectThreadPrRefs}, scraping PR links out of message
 * text), so a compacted entry carries that scrape's *result* in `prRefs` and
 * drops the messages.
 */
export interface SidebarThread {
  id: string
  title: string
  status: Thread['status']
  unreadAt?: number
  archivedAt?: number
  automation?: Thread['automation']
  remoteAgentLink?: Thread['remoteAgentLink']
  /** The live transcript. Absent once the entry has been compacted. */
  messages?: Message[]
  /** `false` when `messages` is empty only because it was never read off disk. */
  messagesLoaded?: boolean
  /**
   * PR refs to fall back on when there is no transcript to scrape — cached on a
   * thread's metadata by the loader, or computed at compaction time.
   */
  prRefs?: GithubPrRef[]
}

/**
 * PR refs for the status chip.
 *
 * A transcript that is actually in memory must still be re-scraped:
 * `appendToken` mutates message content in place while the agent streams, so a
 * PR link posted mid-turn is only found by re-reading. But the scrape is
 * unioned with the cached `prRefs`, not preferred over them — the cache also
 * carries refs recorded without any prose to scrape (a PR opened by
 * `gh_pr_create` is linked from the tool result itself). With no transcript to
 * read — an entry compacted on switching away, or a thread never loaded off
 * disk (`messagesLoaded: false`) — the cache stands alone.
 */
export function sidebarPrRefs(thread: SidebarThread): GithubPrRef[] {
  if (thread.messages && thread.messagesLoaded !== false) {
    const scraped = collectThreadPrRefs({
      messages: thread.messages,
      ...(thread.remoteAgentLink ? { remoteAgentLink: thread.remoteAgentLink } : {}),
    })
    const seen = new Set(scraped.map(githubPrKey))
    const cachedOnly = (thread.prRefs ?? []).filter((ref) => !seen.has(githubPrKey(ref)))
    return [...scraped, ...cachedOnly]
  }
  return thread.prRefs ?? []
}

/**
 * Snapshot a thread down to its sidebar row, releasing the transcript. Idempotent
 * — compacting an already-compacted entry returns the same fields.
 */
export function compactSidebarThread(thread: SidebarThread): SidebarThread {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    ...(thread.unreadAt !== undefined ? { unreadAt: thread.unreadAt } : {}),
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.automation ? { automation: thread.automation } : {}),
    ...(thread.remoteAgentLink ? { remoteAgentLink: thread.remoteAgentLink } : {}),
    prRefs: sidebarPrRefs(thread),
  }
}
