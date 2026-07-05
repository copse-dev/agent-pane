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
import { homedir } from 'node:os'
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
import { parseSpine, serializeSpine, type ThreadMeta } from '@shared/threads/spine-schema.ts'
import {
  remoteAgentPrIndexKey,
  type RemoteAgentLink,
  type RemoteAgentPrIndexEntry,
} from '@shared/remote-agent-link.ts'
import { storageGet } from './storage/storage.ts'
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

/** Root of the chat store. `COPSE_WORKSPACE_DIR` overrides it (tests, relocation). */
function workspaceRoot(): string {
  const override = process.env['COPSE_WORKSPACE_DIR']?.trim()
  if (override) return override
  return join(homedir(), '.copse', 'workspace')
}

function projectDir(projectId: string): string {
  return join(workspaceRoot(), projectId)
}

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
 */
function writeThread(projectId: string, thread: Thread): void {
  const dir = threadDir(projectId, thread.id)
  mkdirSync(dir, { recursive: true })

  const { spine, files } = explodeThread(thread.messages, sha256)
  for (const file of files) writeFileEnsuringDir(join(dir, file.ref), file.contents)
  writeFileSync(join(dir, EVENTS_FILE), serializeSpine(spine))
  writeFileSync(join(dir, META_FILE), `${JSON.stringify(metaOf(thread))}\n`)

  pruneStaleFiles(dir, files)
}

function pruneStaleFiles(dir: string, files: FileToWrite[]): void {
  const keep = new Set(files.map((f) => f.ref))
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

/**
 * Merge two links, requiring the result to carry the launch-time identity
 * (`provider`/`agentId`/`createdAt`). Returns null when the merge cannot form a
 * valid link — e.g. a prUrl-only patch arriving before any launch was recorded,
 * which we drop rather than persist a half-formed link.
 */
function mergeAgentLink(
  existing: RemoteAgentLink | undefined,
  patch: Partial<RemoteAgentLink>,
): RemoteAgentLink | null {
  const merged = { ...(existing ?? {}), ...patch }
  if (
    typeof merged.provider !== 'string' ||
    typeof merged.agentId !== 'string' ||
    typeof merged.createdAt !== 'number'
  ) {
    return null
  }
  return merged as RemoteAgentLink
}

// --- Public API (mirrors the former thread-persistence surface) -------------

const queueKey = (projectId: string): string => `thread-store:${projectId}`

/** A thread's on-disk metadata (`meta.json`), or null if missing/malformed. */
export function getThreadMeta(projectId: string, threadId: string): Promise<ThreadMeta | null> {
  return runSerialized(queueKey(projectId), () => readMeta(threadDir(projectId, threadId)))
}

/**
 * Merge `patch` into the thread's `remoteAgentLink` and keep the reverse index
 * in step — atomically, on the same per-project queue as every other meta write
 * so a concurrent renderer reconcile can't clobber it. Used to record the launch
 * (provider/agentId/runId/branch/repo/createdAt) and later attach the `prUrl`.
 */
export function upsertThreadAgentLink(
  projectId: string,
  threadId: string,
  patch: Partial<RemoteAgentLink>,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    // Only patch an existing thread; the renderer writes the initial meta.json.
    if (current === null) return
    const merged = mergeAgentLink(current.remoteAgentLink, patch)
    if (merged === null) return
    const nextMeta: ThreadMeta = { ...current, remoteAgentLink: merged, id: threadId }
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(nextMeta)}\n`)
    if (merged.prUrl) {
      const index = existsSync(agentPrIndexPath(projectId))
        ? readAgentPrIndex(projectId)
        : rebuildAgentPrIndexInner(projectId)
      indexAgentLink(index, threadId, merged)
      writeAgentPrIndex(projectId, index)
    }
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
    const index = existsSync(agentPrIndexPath(projectId))
      ? readAgentPrIndex(projectId)
      : rebuildAgentPrIndexInner(projectId)
    return index.get(key) ?? null
  })
}

/** Rebuild the reverse index from thread metas (recovery / migration). */
export function rebuildAgentPrIndex(projectId: string): Promise<RemoteAgentPrIndexEntry[]> {
  return runSerialized(queueKey(projectId), () => [...rebuildAgentPrIndexInner(projectId).values()])
}

/** Every `prUrl → thread` link for a project, rebuilding the index if absent. */
export function listAgentPrLinks(projectId: string): Promise<RemoteAgentPrIndexEntry[]> {
  return runSerialized(queueKey(projectId), () => {
    const index = existsSync(agentPrIndexPath(projectId))
      ? readAgentPrIndex(projectId)
      : rebuildAgentPrIndexInner(projectId)
    return [...index.values()]
  })
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
 * `updatedAt` through it around the same time.
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
    const spine = parseSpine(safeRead(join(dir, EVENTS_FILE)) ?? '')
    const existingIndex = spine.findIndex((entry) => entry.id === message.id)
    if (existingIndex >= 0) spine[existingIndex] = line
    else spine.push(line)
    writeFileSync(join(dir, EVENTS_FILE), serializeSpine(spine))
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
