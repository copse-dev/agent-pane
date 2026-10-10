import { parseGithubPrUrl } from './github-pr-url.ts'
import type { Thread, ThreadLink } from './thread-types.ts'

/**
 * Non-PR links a thread has mentioned, for the Context panel's "Links and
 * references" section (prototype #3538). Pull requests keep their own, richer
 * relationship model (`thread-pr-relations.ts`), so GitHub PR URLs are excluded
 * here rather than listed twice.
 *
 * Two kinds exist: `url` (any http/https page) and `thread` (a Copse thread link,
 * `copse://thread/<id>` or the `copse.dev/open` form). Both are read from message
 * text only. An `@`-thread attachment records just a label today, so it cannot
 * be indexed until the composer records the id (a gap noted in the spike report).
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+|copse:\/\/thread\/[a-f0-9-]+/gi
const THREAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
const MAX_LINKS_PER_MESSAGE = 50
export const MAX_LINKS_PER_THREAD = 200

function threadIdFromHref(href: string): string | null {
  const deep = /^copse:\/\/thread\/([a-f0-9-]+)$/i.exec(href)
  if (deep?.[1] !== undefined) return THREAD_ID.test(deep[1]) ? deep[1].toLowerCase() : null
  try {
    const url = new URL(href)
    if (url.hostname !== 'copse.dev' || !url.pathname.startsWith('/open')) return null
    const id = new URLSearchParams(url.hash.slice(1)).get('thread')
    return id !== null && THREAD_ID.test(id) ? id.toLowerCase() : null
  } catch {
    return null
  }
}

function toLink(raw: string): ThreadLink | null {
  const href = raw.replace(TRAILING_PUNCTUATION, '')
  const threadId = threadIdFromHref(href)
  if (threadId !== null) return { kind: 'thread', target: threadId }
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (parseGithubPrUrl(url.href) !== null) return null
  url.hash = ''
  return { kind: 'url', target: url.href }
}

/** Links in one piece of text, in order of first appearance. */
export function extractThreadLinks(text: string): ThreadLink[] {
  const seen = new Set<string>()
  const links: ThreadLink[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const link = toLink(match[0])
    if (!link) continue
    const key = `${link.kind}:${link.target}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push(link)
    if (links.length >= MAX_LINKS_PER_MESSAGE) break
  }
  return links
}

/** Union `found` into `existing`, append-only, capped per thread. */
export function mergeThreadLinks(
  existing: readonly ThreadLink[],
  found: readonly ThreadLink[],
): { links: ThreadLink[]; added: boolean } {
  const links = [...existing]
  const seen = new Set(links.map((link) => `${link.kind}:${link.target}`))
  let added = false
  for (const link of found) {
    if (links.length >= MAX_LINKS_PER_THREAD) break
    const key = `${link.kind}:${link.target}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push(link)
    added = true
  }
  return { links, added }
}

/**
 * Every link in a loaded transcript. A thread never links to itself, so its own
 * `copse://` id is dropped.
 */
export function collectThreadLinks(
  thread: Pick<Thread, 'messages'> & { id?: string },
): ThreadLink[] {
  let links: ThreadLink[] = []
  for (const message of thread.messages) {
    links = mergeThreadLinks(links, extractThreadLinks(message.content)).links
  }
  return thread.id === undefined
    ? links
    : links.filter((link) => !(link.kind === 'thread' && link.target === thread.id))
}

/** A thread that links to a target: one backlink row. */
export interface ThreadBacklink {
  threadId: string
  title: string
}

/**
 * In-memory backlink lookup over thread metadata. It is the file-reader fallback
 * and the demo/test oracle for the SQLite `links` table, mirroring how
 * `ThreadPrRelationshipIndex` backs `pr_links`.
 */
export function backlinksFor(
  threads: readonly Pick<Thread, 'id' | 'title' | 'links' | 'archivedAt'>[],
  kind: ThreadLink['kind'],
  target: string,
): ThreadBacklink[] {
  return threads
    .filter(
      (thread) =>
        thread.archivedAt == null &&
        (thread.links ?? []).some((link) => link.kind === kind && link.target === target),
    )
    .map((thread) => ({ threadId: thread.id, title: thread.title }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId))
}
