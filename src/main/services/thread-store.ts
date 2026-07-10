import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Message, Thread, ThreadCatalogEntry, ThreadCatalogHit } from '@shared/types'
import { sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'
import {
  explodeMessage,
  explodeThread,
  foldThread,
  type FileToWrite,
  type RefResolver,
} from '@shared/threads/fold.ts'
import { parseOkfMessage } from '@shared/threads/okf-message.ts'
import {
  parseSpine,
  parseSpineEntries,
  rebuildSpinePreservingNonMessageLines,
  serializeSpineEntries,
  serializeSpineLine,
  type SpineHookRunLine,
  type ThreadMeta,
} from '@shared/threads/spine-schema.ts'
import {
  remoteAgentPrIndexKey,
  type RemoteAgentLink,
  type RemoteAgentPrIndexEntry,
} from '@shared/remote-agent-link.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import { storageGet } from './storage/storage.ts'
import { projectStoreDir } from './storage/copse-paths.ts'
import { runSerialized } from './storage/write-queue.ts'

/**
 * Filesystem-native thread store (issue #644). Each thread is a self-contained
 * directory under `~/.copse/workspace/<projectId>/<threadId>/`:
 *
 *   meta.json      mutable thread metadata (everything except messages)
 *   events.jsonl   append-only spine, one line per finalized message
 *   messages/*.md  OKF prose (message content + reasoning)
 *   blobs/*        verbatim tool results and images
 *   subagents/**   nested subagent sessions, same structure recursively
 *
 * A per-project `catalog.jsonl` indexes threads for fast cross-thread lookup
 * (rebuildable from the thread dirs). Prose/blob split, 1:1 fidelity, and the
 * fold/explode round-trip live in `@shared/threads`.
 *
 * This module keeps the same public surface the old single-JSON-blob store
 * exposed (`loadProjectThreads`/`saveProjectThread`/…), so IPC and the renderer
 * are unchanged; event-level appends and streaming come in later phases.
 */

const EVENTS_FILE = 'events.jsonl'
const META_FILE = 'meta.json'
const CATALOG_FILE = 'catalog.jsonl'
const AGENT_PR_INDEX_FILE = 'agent-pr-index.jsonl'
const CONTENT_DIRS = ['messages', 'blobs', 'subagents']

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

const projectDir = projectStoreDir

function threadDir(projectId: string, threadId: string): string {
  return join(projectDir(projectId), threadId)
}

function catalogPath(projectId: string): string {
  return join(projectDir(projectId), CATALOG_FILE)
}

function agentPrIndexPath(projectId: string): string {
  return join(projectDir(projectId), AGENT_PR_INDEX_FILE)
}

function metaOf(thread: Thread): ThreadMeta {
  const { messages: _messages, ...meta } = thread
  return meta
}

function writeFileEnsuringDir(fullPath: string, contents: string): void {
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, contents)
}

/** Every file under `dir`, as thread-relative posix paths (excludes directories). */
function listFilesRecursive(dir: string, base: string = dir): string[] {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base))
    } else {
      out.push(relative(base, full).split(sep).join('/'))
    }
  }
  return out
}

/**
 * Write a thread directory. Files are written first, then the spine, then meta;
 * because the spine (`events.jsonl`) is written only after the files it
 * references exist, a crash mid-write never leaves the spine pointing at a
 * missing file (the previous spine still resolves against the still-present old
 * files). Stale files from a shrunk message set are pruned last (best-effort).
 *
 * The spine is regenerated from `thread.messages` alone, but non-message lines
 * (hook_run records, future line types) live only in `events.jsonl` — so the
 * rewrite read-merges the existing file to carry them through (decision 6 of
 * docs/plans/hooks-and-feature-packs.md; see
 * {@link rebuildSpinePreservingNonMessageLines} for why read-merge-write was
 * chosen over carrying them in memory). Blobs those preserved lines reference
 * are exempted from pruning.
 */
function writeThread(projectId: string, thread: Thread): void {
  const dir = threadDir(projectId, thread.id)
  mkdirSync(dir, { recursive: true })

  const { spine, files } = explodeThread(thread.messages, sha256)
  for (const file of files) writeFileEnsuringDir(join(dir, file.ref), file.contents)
  const existingRaw = safeRead(join(dir, EVENTS_FILE)) ?? ''
  const { body, preservedRefs } = rebuildSpinePreservingNonMessageLines(existingRaw, spine)
  writeFileSync(join(dir, EVENTS_FILE), body)
  writeFileSync(join(dir, META_FILE), `${JSON.stringify(metaOf(thread))}\n`)

  pruneStaleFiles(dir, files, preservedRefs)
}

function pruneStaleFiles(dir: string, files: FileToWrite[], preservedRefs: string[] = []): void {
  const keep = new Set([...files.map((f) => f.ref), ...preservedRefs])
  for (const contentDir of CONTENT_DIRS) {
    const root = join(dir, contentDir)
    if (!existsSync(root)) continue
    for (const rel of listFilesRecursive(root, dir)) {
      if (!keep.has(rel)) {
        try {
          unlinkSync(join(dir, rel))
        } catch {
          // Best-effort cleanup; an orphaned blob is harmless (the spine ignores it).
        }
      }
    }
  }
}

/** Parse a thread's `meta.json`, or null if missing/malformed. */
function readMeta(dir: string): ThreadMeta | null {
  const raw = safeRead(join(dir, META_FILE))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Thread).id !== 'string'
    ) {
      return null
    }
    return parsed as ThreadMeta
  } catch {
    return null
  }
}

function readThread(projectId: string, threadId: string): Thread | null {
  const dir = threadDir(projectId, threadId)
  const meta = readMeta(dir)
  if (meta === null) return null

  const spine = parseSpine(safeRead(join(dir, EVENTS_FILE)) ?? '')
  const resolve: RefResolver = (ref) => {
    const contents = safeRead(join(dir, ref))
    if (contents === null) throw new Error(`Missing thread file: ${ref}`)
    return contents
  }
  try {
    return foldThread(meta, spine, resolve, { hash: sha256 })
  } catch (err) {
    console.warn(`[thread-store] Skipping unreadable thread ${threadId}:`, err)
    return null
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function listThreadIds(projectId: string): string[] {
  const dir = projectDir(projectId)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

function readProjectThreads(projectId: string): Thread[] {
  const threads: Thread[] = []
  for (const threadId of listThreadIds(projectId)) {
    const thread = readThread(projectId, threadId)
    if (thread) threads.push(thread)
  }
  return sortThreadsNewestFirst(threads)
}

// --- Catalog (fast cross-thread index; derived, rebuildable) ----------------

export type CatalogEntry = ThreadCatalogEntry

function digestOf(thread: Thread): string {
  const firstUser = thread.messages.find((m) => m.role === 'user')?.content ?? ''
  return [thread.title, thread.workingBrief ?? '', firstUser]
    .filter(Boolean)
    .join(' — ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

function catalogEntryOf(thread: Thread): CatalogEntry {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    digest: digestOf(thread),
    path: thread.id,
  }
}

function readCatalog(projectId: string): Map<string, CatalogEntry> {
  const raw = safeRead(catalogPath(projectId))
  const map = new Map<string, CatalogEntry>()
  if (raw === null) return map
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line) as CatalogEntry
      if (typeof entry.id === 'string') map.set(entry.id, entry)
    } catch {
      // Skip malformed line; the catalog is rebuildable.
    }
  }
  return map
}

function writeCatalog(projectId: string, entries: Map<string, CatalogEntry>): void {
  const sorted = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  mkdirSync(projectDir(projectId), { recursive: true })
  writeFileSync(catalogPath(projectId), sorted.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function upsertCatalogEntry(projectId: string, thread: Thread): void {
  const entries = readCatalog(projectId)
  entries.set(thread.id, catalogEntryOf(thread))
  writeCatalog(projectId, entries)
}

/** First user message body, read straight from disk (O(1) — no whole-thread fold). */
function firstUserContent(dir: string): string {
  const spine = parseSpine(safeRead(join(dir, EVENTS_FILE)) ?? '')
  const line = spine.find((l) => l.role === 'user')
  if (!line) return ''
  const raw = safeRead(join(dir, line.content.ref))
  if (raw === null) return ''
  return parseOkfMessage(raw)?.body ?? ''
}

/**
 * Build a catalog entry from a thread's on-disk `meta.json` + its first user
 * message, without folding the whole thread. Used by the event-level API so an
 * append/patch refreshes the catalog in O(1) rather than O(messages).
 */
function catalogEntryFromDisk(projectId: string, threadId: string): CatalogEntry | null {
  const dir = threadDir(projectId, threadId)
  const meta = readMeta(dir)
  if (meta === null) return null
  const digest = [meta.title, meta.workingBrief ?? '', firstUserContent(dir)]
    .filter(Boolean)
    .join(' — ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    digest,
    path: meta.id,
  }
}

function refreshCatalogLine(projectId: string, threadId: string): void {
  const entry = catalogEntryFromDisk(projectId, threadId)
  if (entry === null) return
  const entries = readCatalog(projectId)
  entries.set(threadId, entry)
  writeCatalog(projectId, entries)
}

function rebuildCatalog(projectId: string): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>()
  for (const thread of readProjectThreads(projectId)) {
    entries.set(thread.id, catalogEntryOf(thread))
  }
  writeCatalog(projectId, entries)
  return entries
}

// --- Agent-run ↔ PR reverse index (derived, rebuildable) --------------------
// Mirrors the catalog: a per-project JSONL index folded off the thread metas
// (issue #690, Q6) so the PR pane can resolve `prUrl → { threadId, agentId,
// provider }` without folding every thread. Source of truth is each thread's
// `meta.json.remoteAgentLink`; this index is always rebuildable from those.

function readAgentPrIndex(projectId: string): Map<string, RemoteAgentPrIndexEntry> {
  const raw = safeRead(agentPrIndexPath(projectId))
  const map = new Map<string, RemoteAgentPrIndexEntry>()
  if (raw === null) return map
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line) as RemoteAgentPrIndexEntry
      const key = remoteAgentPrIndexKey(entry.prUrl)
      if (key && typeof entry.threadId === 'string') map.set(key, entry)
    } catch {
      // Skip malformed line; the index is rebuildable.
    }
  }
  return map
}

function writeAgentPrIndex(projectId: string, entries: Map<string, RemoteAgentPrIndexEntry>): void {
  mkdirSync(projectDir(projectId), { recursive: true })
  const body = [...entries.values()].map((e) => JSON.stringify(e)).join('\n')
  writeFileSync(agentPrIndexPath(projectId), body ? `${body}\n` : '')
}

/** Fold a link into an in-memory index map. No-op when the link has no PR yet. */
function indexAgentLink(
  map: Map<string, RemoteAgentPrIndexEntry>,
  threadId: string,
  link: RemoteAgentLink,
): void {
  if (!link.prUrl) return
  const key = remoteAgentPrIndexKey(link.prUrl)
  if (!key) return
  map.set(key, {
    prUrl: link.prUrl,
    threadId,
    agentId: link.agentId,
    provider: link.provider,
  })
}

/** Drop every reverse-index entry pointing at a thread. Returns whether it changed. */
function removeThreadFromIndex(
  map: Map<string, RemoteAgentPrIndexEntry>,
  threadId: string,
): boolean {
  let changed = false
  for (const [key, entry] of map) {
    if (entry.threadId === threadId) {
      map.delete(key)
      changed = true
    }
  }
  return changed
}

/** Rebuild the reverse index by scanning every thread's `meta.json`. */
function rebuildAgentPrIndexInner(projectId: string): Map<string, RemoteAgentPrIndexEntry> {
  const map = new Map<string, RemoteAgentPrIndexEntry>()
  for (const threadId of listThreadIds(projectId)) {
    const meta = readMeta(threadDir(projectId, threadId))
    if (meta?.remoteAgentLink) indexAgentLink(map, threadId, meta.remoteAgentLink)
  }
  writeAgentPrIndex(projectId, map)
  return map
}

/** Read the reverse index, rebuilding it from thread metas when the file is absent. */
function loadOrRebuildAgentPrIndex(projectId: string): Map<string, RemoteAgentPrIndexEntry> {
  return existsSync(agentPrIndexPath(projectId))
    ? readAgentPrIndex(projectId)
    : rebuildAgentPrIndexInner(projectId)
}

function canonicalPrUrl(ref: GithubPrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${String(ref.number)}`
}

/**
 * Pick which PR the agent actually opened from the URLs scraped out of its reply.
 * When the launch recorded a repo, keep only PRs in that repo and take the last
 * mention (the PR it just opened tends to follow any it merely references) — and
 * if none match, attach nothing rather than mislink a referenced PR. With no
 * launch repo (git lookup failed), fall back to the last PR mentioned.
 */
function pickPrUrlForRepo(refs: GithubPrRef[], repo: string | undefined): string | undefined {
  const candidates = repo ? refs.filter((r) => `${r.owner}/${r.repo}` === repo) : refs
  const chosen = candidates.length > 0 ? candidates[candidates.length - 1] : undefined
  return chosen ? canonicalPrUrl(chosen) : undefined
}

// --- Public API (mirrors the former thread-persistence surface) -------------

const queueKey = (projectId: string): string => `thread-store:${projectId}`

/** A thread's on-disk metadata (`meta.json`), or null if missing/malformed. */
export function getThreadMeta(projectId: string, threadId: string): Promise<ThreadMeta | null> {
  return runSerialized(queueKey(projectId), () => readMeta(threadDir(projectId, threadId)))
}

/**
 * Record the launch link on a thread, replacing any prior one — a fresh launch
 * supersedes the previous run, so its stale reverse-index entries are dropped
 * (the new link has no `prUrl` yet; {@link attachThreadPrUrl} fills it in). Runs
 * on the same per-project queue as every other meta write so a concurrent
 * renderer reconcile can't clobber it.
 */
export function recordThreadAgentLink(
  projectId: string,
  threadId: string,
  link: RemoteAgentLink,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    // Only patch an existing thread; the renderer writes the initial meta.json.
    if (current === null) return
    const nextMeta: ThreadMeta = { ...current, remoteAgentLink: { ...link }, id: threadId }
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(nextMeta)}\n`)
    const index = loadOrRebuildAgentPrIndex(projectId)
    let changed = removeThreadFromIndex(index, threadId)
    if (link.prUrl) {
      indexAgentLink(index, threadId, link)
      changed = true
    }
    if (changed) writeAgentPrIndex(projectId, index)
  })
}

/**
 * Attach the PR the agent opened, chosen from the URLs scraped out of its reply.
 * Write-once: it no-ops unless a launch was recorded and no PR is linked yet, so
 * a follow-up turn that mentions another PR can't repoint the link. See
 * {@link pickPrUrlForRepo} for how the PR is selected.
 */
export function attachThreadPrUrl(
  projectId: string,
  threadId: string,
  refs: GithubPrRef[],
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    if (refs.length === 0) return
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    const link = current?.remoteAgentLink
    if (!current || !link || link.prUrl) return
    const prUrl = pickPrUrlForRepo(refs, link.repo)
    if (!prUrl) return
    const merged: RemoteAgentLink = { ...link, prUrl }
    const nextMeta: ThreadMeta = { ...current, remoteAgentLink: merged, id: threadId }
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(nextMeta)}\n`)
    const index = loadOrRebuildAgentPrIndex(projectId)
    indexAgentLink(index, threadId, merged)
    writeAgentPrIndex(projectId, index)
  })
}

/** Resolve `prUrl → { threadId, agentId, provider }`, rebuilding the index if absent. */
export function lookupThreadByPrUrl(
  projectId: string,
  prUrl: string,
): Promise<RemoteAgentPrIndexEntry | null> {
  return runSerialized(queueKey(projectId), () => {
    const key = remoteAgentPrIndexKey(prUrl)
    if (!key) return null
    return loadOrRebuildAgentPrIndex(projectId).get(key) ?? null
  })
}

/** Rebuild the reverse index from thread metas (recovery / migration). */
export function rebuildAgentPrIndex(projectId: string): Promise<RemoteAgentPrIndexEntry[]> {
  return runSerialized(queueKey(projectId), () => [...rebuildAgentPrIndexInner(projectId).values()])
}

/** Every `prUrl → thread` link for a project, rebuilding the index if absent. */
export function listAgentPrLinks(projectId: string): Promise<RemoteAgentPrIndexEntry[]> {
  return runSerialized(queueKey(projectId), () => [
    ...loadOrRebuildAgentPrIndex(projectId).values(),
  ])
}

export function loadProjectThreads(projectId: string): Promise<Thread[]> {
  return runSerialized(queueKey(projectId), () => readProjectThreads(projectId))
}

export function saveProjectThread(projectId: string, thread: Thread): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    writeThread(projectId, thread)
    upsertCatalogEntry(projectId, thread)
  })
}

export function saveProjectThreads(projectId: string, threads: Thread[]): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const keepIds = new Set<string>()
    const entries = new Map<string, CatalogEntry>()
    for (const thread of threads) {
      keepIds.add(thread.id)
      writeThread(projectId, thread)
      entries.set(thread.id, catalogEntryOf(thread))
    }
    for (const threadId of listThreadIds(projectId)) {
      if (!keepIds.has(threadId)) {
        rmSync(threadDir(projectId, threadId), { recursive: true, force: true })
      }
    }
    writeCatalog(projectId, entries)
  })
}

// --- Event-level API (Phase 2) ----------------------------------------------
// The renderer maps store events onto these instead of rewriting whole threads:
// `createThread` on a new thread, `appendMessage` on each finalized message, and
// debounced `updateMeta` for draft/usage/status/todos/title changes. All run
// through the same per-project queue as the whole-thread paths to keep ordering.

/** Create a thread directory from its metadata (+ any initial messages). */
export function createThread(projectId: string, thread: Thread): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    writeThread(projectId, thread)
    upsertCatalogEntry(projectId, thread)
  })
}

/**
 * Persist one finalized message: its OKF/blob files, then its spine line. The
 * spine line replaces any existing line with the same id in place (idempotent
 * re-finalize / edit without reordering history) and is otherwise appended;
 * writing files before the spine keeps a crash from leaving the spine pointing
 * at a missing file. `meta.json` is left to `updateMeta` — the renderer bumps
 * `updatedAt` through it around the same time. The rewrite works on verbatim
 * spine entries so non-message lines (hook_run and unknown future types) keep
 * their exact bytes and positions.
 */
export function appendMessage(
  projectId: string,
  threadId: string,
  message: Message,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    mkdirSync(dir, { recursive: true })
    const { line, files } = explodeMessage(message, sha256)
    for (const file of files) writeFileEnsuringDir(join(dir, file.ref), file.contents)
    const entries = parseSpineEntries(safeRead(join(dir, EVENTS_FILE)) ?? '')
    const raw = serializeSpineLine(line)
    const existingIndex = entries.findIndex(
      (entry) => entry.line?.type === 'message' && entry.line.id === message.id,
    )
    if (existingIndex >= 0) entries[existingIndex] = { raw, line }
    else entries.push({ raw, line })
    writeFileSync(join(dir, EVENTS_FILE), serializeSpineEntries(entries))
  })
}

/**
 * Append one hook execution record (decision 6: always-on spine recording).
 * Blobs (raw stdout/stderr, toolset fingerprint) are written before the line so
 * a crash never leaves the spine pointing at a missing file — the same commit
 * ordering as message appends. Content-addressed blobs (`blobs/toolset-*.json`)
 * are deduped by skipping the write when the file already exists.
 */
export function appendHookRun(
  projectId: string,
  threadId: string,
  line: SpineHookRunLine,
  blobs: FileToWrite[] = [],
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    mkdirSync(dir, { recursive: true })
    for (const blob of blobs) {
      const full = join(dir, blob.ref)
      if (!existsSync(full)) writeFileEnsuringDir(full, blob.contents)
    }
    const existingRaw = safeRead(join(dir, EVENTS_FILE)) ?? ''
    const prefix =
      existingRaw === '' || existingRaw.endsWith('\n') ? existingRaw : `${existingRaw}\n`
    writeFileSync(join(dir, EVENTS_FILE), `${prefix}${serializeSpineLine(line)}\n`)
  })
}

/** Patch a thread's mutable metadata in place and refresh its catalog line. */
export function updateMeta(
  projectId: string,
  threadId: string,
  patch: Partial<ThreadMeta>,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    // updateMeta only patches an existing thread; `createThread` writes the
    // initial meta.json, so a missing base means there is nothing to patch.
    if (current === null) return
    const merged: ThreadMeta = { ...current, ...patch, id: threadId }
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(merged)}\n`)
    refreshCatalogLine(projectId, threadId)
  })
}

export function deleteProjectThread(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    rmSync(threadDir(projectId, threadId), { recursive: true, force: true })
    const entries = readCatalog(projectId)
    if (entries.delete(threadId)) writeCatalog(projectId, entries)
    // Drop the thread's reverse-index entries too, so a deleted thread can't
    // keep badging a PR / offering an "open thread" jump to a ghost thread.
    if (existsSync(agentPrIndexPath(projectId))) {
      const index = readAgentPrIndex(projectId)
      if (removeThreadFromIndex(index, threadId)) writeAgentPrIndex(projectId, index)
    }
  })
}

/**
 * Catalog entries for a project, newest first, optionally filtered by a query.
 * Each hit carries its absolute `events.jsonl` path (resolved here, not stored)
 * so the `@`-thread picker can hand the agent an absolute reference.
 */
export function loadProjectCatalog(projectId: string, query?: string): Promise<ThreadCatalogHit[]> {
  return runSerialized(queueKey(projectId), () => {
    const map = existsSync(catalogPath(projectId))
      ? readCatalog(projectId)
      : rebuildCatalog(projectId)
    const entries = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    const terms = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const matched =
      terms.length === 0
        ? entries
        : entries.filter((e) => {
            const haystack = `${e.title}\n${e.digest}`.toLowerCase()
            return terms.every((term) => haystack.includes(term))
          })
    return matched.map((e) => ({
      ...e,
      spinePath: join(threadDir(projectId, e.path), EVENTS_FILE),
    }))
  })
}

/** Load every thread across all projects (usage summaries, etc.). */
export function loadAllProjectThreads(): Thread[] {
  const projects =
    (storageGet('projects') as Array<{ id: string }> | null)?.filter(
      (p) => typeof p.id === 'string' && p.id.length > 0,
    ) ?? []
  const threads: Thread[] = []
  for (const project of projects) {
    threads.push(...readProjectThreads(project.id))
  }
  return threads
}
