// Stage 1, the pull request's conversation (docs/plans/copse-reviewer.md,
// §Pipeline: "where a PR exists — its description and review history").
//
// The description, the discussion, submitted reviews and their inline comments,
// read from the forge's REST API as data. Humans and automation both post there:
// a reviewer's request, a bot's before/after screenshot table, a preview link.
// Nothing here is specific to one repository's bots; an image is an image
// wherever it was posted, and a table row's text labels the images in it.
//
// Every byte is attacker-controllable (P7): the rendering is wrapped as
// external content, images are addressed by an opaque id, and only a URL that
// appeared in the conversation can be fetched, from an allowlisted host.
import { z } from 'zod'
import { wrapExternalContent } from '@copse/agent/external-content.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { isCopseReviewBody, type FetchLike, type Forge } from './forge-review.ts'

/** Which pull request to read; a token is optional for a public repository. */
export interface PullRequestRef {
  readonly forge: Forge
  /** `https://api.github.com` (or a GHE `/api/v3` base), or a Forgejo instance's origin. */
  readonly apiBase: string
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly token?: string | undefined
}

export type ConversationEntryKind = 'description' | 'comment' | 'review' | 'review-comment'

export interface ConversationEntry {
  readonly kind: ConversationEntryKind
  readonly author: string
  /** The forge says so (`type: Bot`) or the login does (`…[bot]`). */
  readonly bot: boolean
  readonly createdAt: string
  /** A review's state: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, … */
  readonly state?: string | undefined
  /** An inline comment's file and line on the head side, when the forge gives one. */
  readonly path?: string | undefined
  readonly line?: number | undefined
  /** The body with every image replaced by its `[image img-N]` handle. */
  readonly body: string
  readonly truncated: boolean
}

export interface ConversationImage {
  /** Opaque handle the reviewer passes to `view_image`: `img-1`, `img-2`, … */
  readonly id: string
  readonly url: string
  /** What the image is, from its alt text or its table row and column. */
  readonly label: string
  /** Who posted it, for the index: `comment by github-actions (bot)`. */
  readonly postedIn: string
}

export interface PullRequestConversation {
  readonly title: string
  readonly entries: readonly ConversationEntry[]
  readonly images: readonly ConversationImage[]
  /** Entries dropped to fit the budget (oldest first, never the description). */
  readonly omittedEntries: number
  /** Images beyond the index cap; their handles in bodies still resolve. */
  readonly omittedImages: number
  /** Copse Reviewer's own reviews, skipped so it never corroborates itself. */
  readonly skippedOwnReviews: number
}

/** A single entry keeps at most this much of its body. */
export const MAX_ENTRY_CHARS = 3_000
/** All entries together, description included. */
export const MAX_CONVERSATION_CHARS = 20_000
/** Images listed in the index the reviewer sees. */
export const MAX_INDEXED_IMAGES = 120
/** Pages of 100 read per list endpoint; a longer thread keeps its newest pages' worth. */
const MAX_PAGES = 5
const PAGE_SIZE = 100
const FORGEJO_PAGE_SIZE = 50

const userSchema = z.object({ login: z.string(), type: z.string().optional() }).nullable()
const pullSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  user: userSchema,
  created_at: z.string(),
})
const commentsSchema = z.array(
  z.object({ body: z.string().nullable(), user: userSchema, created_at: z.string() }),
)
const reviewsSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string().nullable(),
    state: z.string().nullable().optional(),
    user: userSchema,
    submitted_at: z.string().nullable().optional(),
  }),
)
const githubReviewCommentsSchema = z.array(
  z.object({
    body: z.string().nullable(),
    user: userSchema,
    created_at: z.string(),
    path: z.string(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    pull_request_review_id: z.number().nullable().optional(),
  }),
)
const forgejoReviewCommentsSchema = z.array(
  z.object({
    body: z.string().nullable(),
    user: userSchema,
    created_at: z.string(),
    path: z.string(),
    position: z.number().nullable().optional(),
  }),
)

export class PullRequestConversationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PullRequestConversationError'
  }
}

function apiUrl(ref: PullRequestRef, path: string): string {
  const base = ref.apiBase.replace(/\/+$/, '')
  const repo = `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
  return ref.forge === 'github' ? `${base}/${repo}/${path}` : `${base}/api/v1/${repo}/${path}`
}

function apiHeaders(ref: PullRequestRef): Record<string, string> {
  const auth: Record<string, string> =
    ref.token === undefined
      ? {}
      : { Authorization: ref.forge === 'github' ? `Bearer ${ref.token}` : `token ${ref.token}` }
  return ref.forge === 'github'
    ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...auth }
    : { Accept: 'application/json', ...auth }
}

async function getJson<T>(
  ref: PullRequestRef,
  url: string,
  schema: z.ZodType<T>,
  fetchImpl: FetchLike,
): Promise<T> {
  const response = await fetchImpl(url, { method: 'GET', headers: apiHeaders(ref) })
  const text = await response.text()
  if (response.status < 200 || response.status >= 300) {
    throw new PullRequestConversationError(
      `${ref.forge} returned ${String(response.status)} for ${url}: ${text.slice(0, 300)}`,
    )
  }
  const parsed = safeJsonParse(text, decodeWithSchema(schema))
  if (parsed === null) throw new PullRequestConversationError(`${url} returned an unreadable body`)
  return parsed
}

async function getPages<T>(
  ref: PullRequestRef,
  path: string,
  schema: z.ZodType<T[]>,
  fetchImpl: FetchLike,
): Promise<T[]> {
  const size = ref.forge === 'github' ? PAGE_SIZE : FORGEJO_PAGE_SIZE
  const sizeParam = ref.forge === 'github' ? 'per_page' : 'limit'
  const all: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const separator = path.includes('?') ? '&' : '?'
    const items = await getJson(
      ref,
      apiUrl(ref, `${path}${separator}${sizeParam}=${String(size)}&page=${String(page)}`),
      schema,
      fetchImpl,
    )
    all.push(...items)
    if (items.length < size) break
  }
  return all
}

interface RawEntry {
  readonly kind: ConversationEntryKind
  readonly user: z.infer<typeof userSchema>
  readonly createdAt: string
  readonly body: string
  readonly state?: string | undefined
  readonly path?: string | undefined
  readonly line?: number | undefined
}

/** Read the conversation's raw entries; bodies are untouched. */
async function readRawEntries(
  ref: PullRequestRef,
  fetchImpl: FetchLike,
): Promise<{ title: string; entries: RawEntry[]; skippedOwnReviews: number }> {
  const number = String(ref.number)
  const pull = await getJson(ref, apiUrl(ref, `pulls/${number}`), pullSchema, fetchImpl)
  const [comments, reviews] = await Promise.all([
    getPages(ref, `issues/${number}/comments`, commentsSchema, fetchImpl),
    getPages(ref, `pulls/${number}/reviews`, reviewsSchema, fetchImpl),
  ])
  const ownReviews = new Set(
    reviews.filter((review) => isCopseReviewBody(review.body ?? '')).map((review) => review.id),
  )
  const entries: RawEntry[] = [
    {
      kind: 'description',
      user: pull.user,
      createdAt: pull.created_at,
      body: pull.body ?? '',
    },
  ]
  for (const comment of comments) {
    if (isCopseReviewBody(comment.body ?? '')) continue
    entries.push({
      kind: 'comment',
      user: comment.user,
      createdAt: comment.created_at,
      body: comment.body ?? '',
    })
  }
  for (const review of reviews) {
    if (ownReviews.has(review.id)) continue
    // An approval with no text still says something; an empty comment does not.
    const body = review.body ?? ''
    if (body.trim() === '' && review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED')
      continue
    entries.push({
      kind: 'review',
      user: review.user,
      createdAt: review.submitted_at ?? pull.created_at,
      body,
      state: review.state ?? undefined,
    })
  }
  if (ref.forge === 'github') {
    const inline = await getPages(
      ref,
      `pulls/${number}/comments`,
      githubReviewCommentsSchema,
      fetchImpl,
    )
    for (const comment of inline) {
      const reviewId = comment.pull_request_review_id
      if (reviewId !== null && reviewId !== undefined && ownReviews.has(reviewId)) continue
      entries.push({
        kind: 'review-comment',
        user: comment.user,
        createdAt: comment.created_at,
        body: comment.body ?? '',
        path: comment.path,
        line: comment.line ?? comment.original_line ?? undefined,
      })
    }
  } else {
    for (const review of reviews) {
      if (ownReviews.has(review.id)) continue
      const inline = await getJson(
        ref,
        apiUrl(ref, `pulls/${number}/reviews/${String(review.id)}/comments`),
        forgejoReviewCommentsSchema,
        fetchImpl,
      )
      for (const comment of inline) {
        entries.push({
          kind: 'review-comment',
          user: comment.user,
          createdAt: comment.created_at,
          body: comment.body ?? '',
          path: comment.path,
          line: comment.position ?? undefined,
        })
      }
    }
  }
  const [description, ...rest] = entries
  rest.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return {
    title: pull.title,
    entries: description === undefined ? rest : [description, ...rest],
    skippedOwnReviews: ownReviews.size,
  }
}

export interface ExtractedImage {
  readonly url: string
  readonly label: string
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*>/gi
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
}

function isFetchableUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function fileName(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    return last === undefined ? url : decodeURIComponent(last)
  } catch {
    return url
  }
}

/** Visible text of a markdown/HTML fragment, for labels. */
function plainText(fragment: string): string {
  return fragment
    .replace(HTML_IMAGE, ' ')
    .replace(MARKDOWN_IMAGE, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim())
}

/**
 * Replace every image in a body with a handle and return what was found. An
 * image inside a table row is labelled by the row's text cells and its column's
 * header — `settings.png — After` — which is how before/after tables read,
 * whoever posted them. Elsewhere its alt text, else its file name, labels it.
 * `handle(url)` mints (or reuses) the id for a URL.
 */
export function extractImages(
  body: string,
  handle: (image: ExtractedImage) => string,
): { readonly text: string; readonly images: readonly ExtractedImage[] } {
  const images: ExtractedImage[] = []
  const lines = body.split(/\r?\n/)
  let header: string[] | null = null
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const isRow = line.trim().startsWith('|')
    if (isRow && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      header = tableCells(line).map(plainText)
    } else if (!isRow) {
      header = null
    }
    const cells = isRow && header !== null ? tableCells(line) : null
    const rowLabel =
      cells === null
        ? ''
        : cells
            .map(plainText)
            .filter((text) => text.length > 0)
            .join(' · ')
    const labelFor = (alt: string, url: string, position: number): string => {
      if (cells !== null && header !== null) {
        // A row starts with `|`, so the pipes before an image, less one, are its column.
        const column = (line.slice(0, position).match(/(?<!\\)\|/g)?.length ?? 1) - 1
        const heading = header[column] ?? ''
        const parts = [rowLabel, heading].filter((part) => part.length > 0)
        if (parts.length > 0) return parts.join(' — ')
      }
      return alt.trim() || fileName(url)
    }
    const replace = (match: string, alt: string, url: string, position: number): string => {
      if (!isFetchableUrl(url)) return match
      const image = { url, label: labelFor(alt, url, position).slice(0, 160) }
      images.push(image)
      return `[image ${handle(image)}]`
    }
    let rewritten = line.replace(
      MARKDOWN_IMAGE,
      (match, alt: string, url: string, offset: number) => replace(match, alt, url, offset),
    )
    rewritten = rewritten.replace(HTML_IMAGE, (tag: string, offset: number) => {
      const src = htmlAttribute(tag, 'src')
      if (src === undefined) return tag
      return replace(tag, htmlAttribute(tag, 'alt') ?? '', src, offset)
    })
    out.push(rewritten)
  }
  return { text: out.join('\n'), images }
}

function authorOf(user: z.infer<typeof userSchema>): { author: string; bot: boolean } {
  const login = user?.login ?? 'ghost'
  return { author: login, bot: user?.type === 'Bot' || /\[bot\]$/.test(login) }
}

function describeEntry(entry: Pick<ConversationEntry, 'kind' | 'author' | 'bot'>): string {
  const who = `${entry.author}${entry.bot ? ' (bot)' : ''}`
  return entry.kind === 'review-comment' ? `review comment by ${who}` : `${entry.kind} by ${who}`
}

function capBody(text: string, max: number): { body: string; truncated: boolean } {
  if (text.length <= max) return { body: text, truncated: false }
  const cut = text.lastIndexOf('\n', max)
  return { body: text.slice(0, cut > max / 2 ? cut : max), truncated: true }
}

/**
 * Normalise raw entries: images to handles, bodies capped, the whole trimmed to
 * {@link MAX_CONVERSATION_CHARS} by dropping the oldest discussion first. The
 * description always stays; it is what the author says the change is for.
 */
export function buildConversation(
  title: string,
  raw: readonly {
    readonly kind: ConversationEntryKind
    readonly author: string
    readonly bot: boolean
    readonly createdAt: string
    readonly body: string
    readonly state?: string | undefined
    readonly path?: string | undefined
    readonly line?: number | undefined
  }[],
  skippedOwnReviews = 0,
): PullRequestConversation {
  const byUrl = new Map<string, ConversationImage>()
  const images: ConversationImage[] = []
  const entries: ConversationEntry[] = raw.map((entry) => {
    const { text } = extractImages(entry.body, (image) => {
      const existing = byUrl.get(image.url)
      if (existing !== undefined) return existing.id
      const created: ConversationImage = {
        id: `img-${String(images.length + 1)}`,
        url: image.url,
        label: image.label,
        postedIn: describeEntry(entry),
      }
      byUrl.set(image.url, created)
      images.push(created)
      return created.id
    })
    const { body, truncated } = capBody(text.trim(), MAX_ENTRY_CHARS)
    return {
      kind: entry.kind,
      author: entry.author,
      bot: entry.bot,
      createdAt: entry.createdAt,
      ...(entry.state === undefined ? {} : { state: entry.state }),
      ...(entry.path === undefined ? {} : { path: entry.path }),
      ...(entry.line === undefined ? {} : { line: entry.line }),
      body,
      truncated,
    }
  })
  const [description, ...discussion] = entries
  let used = description?.body.length ?? 0
  const kept: ConversationEntry[] = []
  for (let index = discussion.length - 1; index >= 0; index--) {
    const entry = discussion[index]
    if (entry === undefined) continue
    if (used + entry.body.length > MAX_CONVERSATION_CHARS) break
    used += entry.body.length
    kept.unshift(entry)
  }
  return {
    title,
    entries: description === undefined ? kept : [description, ...kept],
    images,
    omittedEntries: discussion.length - kept.length,
    omittedImages: Math.max(0, images.length - MAX_INDEXED_IMAGES),
    skippedOwnReviews,
  }
}

/** Read and normalise a pull request's conversation from its forge. */
export async function readPullRequestConversation(
  ref: PullRequestRef,
  options: { readonly fetch?: FetchLike } = {},
): Promise<PullRequestConversation> {
  const fetchImpl: FetchLike = options.fetch ?? fetch
  const { title, entries, skippedOwnReviews } = await readRawEntries(ref, fetchImpl)
  return buildConversation(
    title,
    entries.map((entry) => ({ ...entry, ...authorOf(entry.user) })),
    skippedOwnReviews,
  )
}

/**
 * The conversation as the reviewer reads it: one external-content envelope,
 * then the image index the `view_image` tool resolves.
 */
export function renderPullRequestConversation(conversation: PullRequestConversation): string {
  const lines: string[] = [`Title: ${conversation.title}`]
  if (conversation.omittedEntries > 0) {
    lines.push(`(${String(conversation.omittedEntries)} older entries omitted to fit the budget)`)
  }
  for (const entry of conversation.entries) {
    const where =
      entry.path === undefined
        ? ''
        : ` on ${entry.path}${entry.line === undefined ? '' : `:${String(entry.line)}`}`
    const state = entry.state === undefined ? '' : ` [${entry.state}]`
    lines.push('', `--- ${describeEntry(entry)}${state}${where}, ${entry.createdAt}`)
    lines.push(entry.body.length === 0 ? '(no text)' : entry.body)
    if (entry.truncated) lines.push('(truncated)')
  }
  const indexed = conversation.images.slice(0, MAX_INDEXED_IMAGES)
  if (indexed.length > 0) {
    lines.push('', 'Images:')
    for (const image of indexed) {
      lines.push(`- ${image.id}: ${image.label} (${image.postedIn})`)
    }
    if (conversation.omittedImages > 0) {
      lines.push(`(${String(conversation.omittedImages)} more images not listed)`)
    }
  }
  return wrapExternalContent('pull_request_conversation', lines.join('\n'))
}
