import type { Message, Thread } from '@shared/types'
import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import { collectThreadPrRefs } from '@shared/git/thread-pr-status.ts'
import { isHumanUserPrompt } from '@copse/thread-store/thread-sort.ts'

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
  /** For the sidebar's Created sort. A compacted entry keeps it. */
  createdAt?: number
  /** Last write to the thread, for the Activity panel's recency fallback. A compacted entry keeps it. */
  updatedAt?: number
  /** When the user last prompted it, for ordering across projects. A compacted entry keeps it. */
  lastPromptAt?: number
  status: Thread['status']
  unreadAt?: number
  archivedAt?: number
  automation?: Thread['automation']
  remoteAgentLink?: Thread['remoteAgentLink']
  /**
   * Whether the thread was ever run, from metadata alone (see {@link sidebarHasRun}).
   * Set at compaction; a live thread derives it on demand.
   */
  everRan?: boolean
  /** The live transcript. Absent once the entry has been compacted. */
  messages?: Message[]
  /** `false` when `messages` is empty only because it was never read off disk. */
  messagesLoaded?: boolean
  /**
   * PR refs to fall back on when there is no transcript to scrape — cached on a
   * thread's metadata by the loader, or computed at compaction time.
   */
  prRefs?: GithubPrRef[]
  prProductions?: Thread['prProductions']
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
  const cached = [...(thread.prRefs ?? []), ...(thread.prProductions ?? []).map((item) => item.pr)]
  if (thread.messages && thread.messagesLoaded !== false) {
    const scraped = collectThreadPrRefs({
      messages: thread.messages,
      ...(thread.remoteAgentLink ? { remoteAgentLink: thread.remoteAgentLink } : {}),
    })
    const seen = new Set(scraped.map(githubPrKey))
    const cachedOnly = cached.filter((ref) => {
      const key = githubPrKey(ref)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return [...scraped, ...cachedOnly]
  }
  return [...new Map(cached.map((ref) => [githubPrKey(ref), ref])).values()]
}

/**
 * When the user last prompted the thread, falling back to its transcript while one
 * is loaded. Undefined for a thread nobody has prompted.
 */
export function sidebarLastPromptAt(thread: SidebarThread): number | undefined {
  if (thread.lastPromptAt !== undefined) return thread.lastPromptAt
  const messages = thread.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message !== undefined && isHumanUserPrompt(message)) return message.createdAt
  }
  return undefined
}

/** The metadata a live {@link Thread} carries beyond {@link SidebarThread}, used to tell it ran. */
export type RunSignals = SidebarThread &
  Partial<Pick<Thread, 'usage' | 'workingBrief' | 'autoTitleCount'>>

/**
 * Whether a thread was ever run, without reading its transcript.
 *
 * `lastPromptAt` is the direct signal, but a thread written before it existed has
 * none until its transcript is first loaded. Those threads still leave marks in
 * their meta: token usage, the working brief set on the first message, or an
 * auto-title pass. Any of them says it ran; an untouched draft has none. A thread
 * that ran without recording any (a zero-usage provider on an old build) is
 * missed until it is opened.
 */
export function sidebarHasRun(thread: RunSignals): boolean {
  if (thread.everRan !== undefined) return thread.everRan
  if (thread.lastPromptAt !== undefined) return true
  if (thread.workingBrief !== undefined || thread.autoTitleCount !== undefined) return true
  return (thread.usage?.inputTokens ?? 0) + (thread.usage?.outputTokens ?? 0) > 0
}

/**
 * Snapshot a thread down to its sidebar row, releasing the transcript. Idempotent
 * — compacting an already-compacted entry returns the same fields.
 */
export function compactSidebarThread(thread: RunSignals): SidebarThread {
  const lastPromptAt = sidebarLastPromptAt(thread)
  return {
    id: thread.id,
    title: thread.title,
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(lastPromptAt !== undefined ? { lastPromptAt } : {}),
    status: thread.status,
    everRan: sidebarHasRun(thread),
    ...(thread.unreadAt !== undefined ? { unreadAt: thread.unreadAt } : {}),
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.automation ? { automation: thread.automation } : {}),
    ...(thread.remoteAgentLink ? { remoteAgentLink: thread.remoteAgentLink } : {}),
    prRefs: sidebarPrRefs(thread),
    ...(thread.prProductions ? { prProductions: thread.prProductions } : {}),
  }
}
