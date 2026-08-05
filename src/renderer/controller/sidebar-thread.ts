import type { Message, Thread } from '@shared/types'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
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
  archivedAt?: number
  remoteAgentLink?: Thread['remoteAgentLink']
  /** The live transcript. Absent once the entry has been compacted. */
  messages?: Message[]
  /** Pre-scraped PR refs. Absent on a live thread, whose messages still change. */
  prRefs?: GithubPrRef[]
}

/**
 * PR refs for the status chip, scraping the transcript only when the entry still
 * has one. A live thread cannot cache its refs: `appendToken` mutates message
 * content in place as the agent streams, so a PR link the agent posts mid-turn
 * has to be found by re-reading, exactly as the sidebar did before.
 */
export function sidebarPrRefs(thread: SidebarThread): GithubPrRef[] {
  if (thread.prRefs) return thread.prRefs
  return collectThreadPrRefs({
    messages: thread.messages ?? [],
    ...(thread.remoteAgentLink ? { remoteAgentLink: thread.remoteAgentLink } : {}),
  })
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
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.remoteAgentLink ? { remoteAgentLink: thread.remoteAgentLink } : {}),
    prRefs: sidebarPrRefs(thread),
  }
}
