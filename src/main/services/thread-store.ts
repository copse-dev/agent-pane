import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type {
  LLMMessage,
  Message,
  Thread,
  ThreadCatalogEntry,
  ThreadCatalogHit,
} from '@shared/types'
import { sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'
import { stripToolResultImages } from '@copse/llm/tool-result-images.ts'
import {
  attachHookCards,
  explodeMessage,
  explodeThread,
  foldThread,
  refsOfLine,
  type FileToWrite,
  type RefResolver,
} from '@shared/threads/fold.ts'
import { parseOkfMessage } from '@shared/threads/okf-message.ts'
import { parseThreadMetaValue } from '@shared/threads/thread-boundary.ts'
import {
  parseSpine,
  parseSpineEntries,
  rebuildSpinePreservingNonMessageLines,
  serializeSpineEntries,
  serializeSpineLine,
  type ContentRef,
  type SpineHookRunLine,
  type SpineMachineContinuationLine,
  type SpinePermissionDecisionLine,
  type ThreadMeta,
} from '@shared/threads/spine-schema.ts'
import {
  remoteAgentPrIndexKey,
  type RemoteAgentLink,
  type RemoteAgentPrIndexEntry,
} from '@shared/remote-agent-link.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import { isRemoteAgentProvider } from '@shared/remote-agent.ts'
import { isRecord, parseJsonUnknown, recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { z } from 'zod'
import { storageGet } from './storage/storage.ts'
import { chatStoreDir, projectStoreDir } from './storage/copse-paths.ts'
import { runSerialized } from './storage/write-queue.ts'

/**
 * Filesystem-native thread store (issue #644). Each thread is a self-contained
 * directory under `~/.copse/workspace/<projectId>/<threadId>/`:
 *
 *   meta.json           mutable thread metadata (everything except messages)
 *   events.jsonl        append-only spine, one line per finalized message
 *   agent-history.json  provider-format LLM resume snapshot (issue #993)
 *   acp-session.json    private external-agent session binding
 *   messages/*.md       OKF prose (message content + reasoning)
 *   blobs/*             verbatim tool results and images
 *   subagents/**        nested subagent sessions, same structure recursively
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
const AGENT_HISTORY_FILE = 'agent-history.json'
const AGENT_HISTORY_VERSION = 1
const ACP_SESSION_FILE = 'acp-session.json'
const AGENT_EPOCH_FILE = 'agent-epoch.json'
const CATALOG_FILE = 'catalog.jsonl'
const AGENT_PR_INDEX_FILE = 'agent-pr-index.jsonl'
const STREAM_STATS_FILE = 'stream-stats.jsonl'
const REASONING_CHECKPOINTS_FILE = 'reasoning-checkpoints.jsonl'
const CONTENT_DIRS = ['messages', 'blobs', 'subagents']

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

const projectDir = projectStoreDir

/** Root of the chat store. COPSE_DIR owns the normal profile layout. */
const workspaceRoot = chatStoreDir

/** Root of the chat store, for callers that need to authorise a path against it. */
export const chatStoreRoot = workspaceRoot

export interface AgentTurnEpoch {
  turnTreeId: string
  continuationUsed: number
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

function streamStatsPath(projectId: string): string {
  return join(projectDir(projectId), STREAM_STATS_FILE)
}

function reasoningCheckpointsPath(projectId: string): string {
  return join(projectDir(projectId), REASONING_CHECKPOINTS_FILE)
}

function metaOf(thread: Thread): ThreadMeta {
  const { messages: _messages, ...meta } = thread
  return meta
}

function writeFileEnsuringDir(fullPath: string, contents: string): void {
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, contents)
}

/** Atomic replace so a crash never leaves a half-written sidecar. */
function atomicWriteFile(path: string, data: string, mode?: number): void {
  const tmp = `${path}.copse-${String(process.pid)}.tmp`
  if (mode === undefined) writeFileSync(tmp, data)
  else writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}

const acpSessionExecutionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z
    .object({
      kind: z.literal('ssh'),
      hostId: z.string().min(1),
      remoteCwd: z.string().min(1),
    })
    .strict(),
])

const acpSessionBindingSchema = z
  .object({
    v: z.literal(1),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    executionTarget: acpSessionExecutionTargetSchema,
    workspaceIdentity: z.string().min(1),
    agentConfigGeneration: z.number().int().nonnegative(),
    createdBy: z.enum(['copse', 'external']),
    lastAttachedAt: z.number().int().nonnegative(),
  })
  .strict()

/**
 * Private durable link from a Copse thread to one external ACP agent session.
 * The opaque session id stays out of thread metadata, spine events, exports,
 * logs, and telemetry; only this owner-readable sidecar persists it.
 */
export type AcpSessionBinding = z.infer<typeof acpSessionBindingSchema>

function isAgentHistoryMessage(value: unknown): value is LLMMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { role?: unknown }).role === 'string'
  )
}

/**
 * Parse `agent-history.json`. Corrupt JSON, missing fields, or a future
 * `v` fail closed to `null` (callers treat that as fresh provider history)
 * without touching the human transcript.
 */
function parseAgentHistoryFile(raw: string): LLMMessage[] | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { v?: unknown; messages?: unknown }
    if (record.v !== AGENT_HISTORY_VERSION) return null
    if (!Array.isArray(record.messages)) return null
    if (!record.messages.every(isAgentHistoryMessage)) return null
    return record.messages
  } catch {
    return null
  }
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
 * Message ids already present in a thread's `events.jsonl`, keyed by the
 * thread's directory path. Seeded by one full parse per thread directory per
 * process lifetime, this lets `appendMessage`'s common case (a brand-new
 * finalized message id) skip parsing and re-serializing the whole spine on
 * every call — see #1222. Anything that rewrites or removes the file outside
 * `appendMessage` must invalidate its entry so the next append reseeds.
 */
const knownMessageIdsByDir = new Map<string, Set<string>>()

function invalidateKnownMessageIds(dir: string): void {
  knownMessageIdsByDir.delete(dir)
}

/** Get (seeding from disk on first use) the known message ids for a thread. */
function knownMessageIdsFor(dir: string): Set<string> {
  const cached = knownMessageIdsByDir.get(dir)
  if (cached) return cached
  const raw = safeRead(join(dir, EVENTS_FILE)) ?? ''
  if (raw !== '' && !raw.endsWith('\n')) {
    // Normalize a legacy file with no trailing newline before switching to
    // true appends below, which assume one is already there.
    writeFileSync(join(dir, EVENTS_FILE), `${raw}\n`)
  }
  const ids = new Set<string>()
  for (const entry of parseSpineEntries(raw)) {
    if (entry.line?.type === 'message') ids.add(entry.line.id)
  }
  knownMessageIdsByDir.set(dir, ids)
  return ids
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
  invalidateKnownMessageIds(dir)

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
  return parseMeta(safeRead(join(dir, META_FILE)))
}

/** Validate `meta.json` contents, however they were read. Null if malformed. */
function parseMeta(raw: string | null): ThreadMeta | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parseThreadMetaValue(parsed)
  } catch {
    return null
  }
}

/**
 * How many file reads are in flight at once while prefetching a thread (and how
 * many threads load concurrently in {@link readProjectThreads}). Enough to keep
 * the disk busy and overlap latency; low enough that a project with thousands of
 * message files cannot exhaust file descriptors.
 */
const READ_CONCURRENCY = 32

/** Run `worker` over `items` with at most {@link READ_CONCURRENCY} in flight. */
async function mapConcurrent<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      // `i` is always in range, but `noUncheckedIndexedAccess` widens the element
      // type — read it out and narrow rather than asserting the index is safe.
      const item = items[i]
      if (item === undefined) continue
      results[i] = await worker(item)
    }
  })
  await Promise.all(runners)
  return results
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Read every file the fold will ask for into memory, so the fold itself can stay
 * synchronous and fs-free while the I/O happens off the main thread.
 *
 * Refs are discovered by walking the spine with {@link refsOfLine}, then
 * recursing into each nested subagent directory (whose own `events.jsonl` has to
 * be read before its refs are knowable). Only referenced files are read —
 * notably NOT `agent-history.json` or `attachments/`, which can be large and
 * which the fold never touches.
 *
 * A ref that fails to read is simply absent from the map; the resolver below
 * then throws exactly the `Missing thread file` error the synchronous resolver
 * used to throw, so a corrupt thread is still skipped rather than half-loaded.
 */
async function prefetchThreadFiles(dir: string, spineRaw: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>()
  // Directory prefixes still to walk, paired with the spine already read for them.
  let frontier: Array<{ prefix: string; raw: string }> = [{ prefix: '', raw: spineRaw }]

  while (frontier.length > 0) {
    const fileRefs: string[] = []
    const nested: string[] = []
    for (const { prefix, raw } of frontier) {
      for (const line of parseSpine(raw)) {
        const { files, subagentDirs } = refsOfLine(line)
        for (const ref of files) fileRefs.push(prefix + ref)
        for (const sub of subagentDirs) nested.push(prefix + sub)
      }
    }

    // A subagent's spine must be read before the next round can walk its refs.
    const nestedSpines = await mapConcurrent(nested, async (prefix) => {
      const raw = await readOrNull(join(dir, prefix + EVENTS_FILE))
      return { prefix, raw }
    })
    await mapConcurrent(fileRefs, async (ref) => {
      const body = await readOrNull(join(dir, ref))
      if (body !== null) contents.set(ref, body)
    })

    frontier = []
    for (const { prefix, raw } of nestedSpines) {
      if (raw === null) continue
      contents.set(prefix + EVENTS_FILE, raw)
      frontier.push({ prefix, raw })
    }
  }
  return contents
}

/**
 * How much of a project's history a load pulls into memory.
 *
 * Archived threads are soft-hidden: the sidebar and the `@`-catalog both drop
 * them, but their directories stay on disk and every message, tool result and
 * base64 image in them used to be folded back into the renderer's store on each
 * project load — a heap that only ever grew, holding history no surface could
 * show. `includeArchived` defaults to true so the whole-history readers (the
 * usage ledger's all-time totals, agent discovery) are unchanged; the renderer's
 * `threads:loadProject` opts out.
 */
export interface ThreadLoadOptions {
  includeArchived?: boolean
}

async function readThread(
  projectId: string,
  threadId: string,
  options: ThreadLoadOptions = {},
): Promise<Thread | null> {
  const dir = threadDir(projectId, threadId)
  const [metaRaw, eventsRaw] = await Promise.all([
    readOrNull(join(dir, META_FILE)),
    readOrNull(join(dir, EVENTS_FILE)),
  ])
  const meta = parseMeta(metaRaw)
  if (meta === null) return null
  // Bail before the prefetch: skipping an archived thread is only worth doing if
  // its message bodies are never read, and that is where the bytes are.
  if (options.includeArchived === false && meta.archivedAt != null) return null

  const raw = eventsRaw ?? ''
  const entries = parseSpineEntries(raw)
  const spine = parseSpine(raw)
  const contents = await prefetchThreadFiles(dir, raw)
  const resolve: RefResolver = (ref) => {
    const body = contents.get(ref)
    if (body === undefined) throw new Error(`Missing thread file: ${ref}`)
    return body
  }
  try {
    const thread = foldThread(meta, spine, resolve, { hash: sha256 })
    // Surface the always-on `hook_run` records (decision 6) as display-only hook
    // cards on the messages they fired within (decisions 10 & 17). Derived from
    // the spine — never from live hook registration — so history stays honest.
    return { ...thread, messages: attachHookCards(thread.messages, entries) }
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

async function readProjectThreads(
  projectId: string,
  options: ThreadLoadOptions = {},
): Promise<Thread[]> {
  const loaded = await mapConcurrent(listThreadIds(projectId), (threadId) =>
    readThread(projectId, threadId, options),
  )
  return sortThreadsNewestFirst(loaded.filter((t): t is Thread => t !== null))
}

/** Store dir ids directly under the workspace root (each is a project's thread store). */
function listProjectStoreIds(): string[] {
  const root = workspaceRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

/** How many thread dirs (a subdir holding a `meta.json`) a store id contains. */
function countThreadDirs(projectId: string): number {
  let count = 0
  for (const threadId of listThreadIds(projectId)) {
    if (existsSync(join(threadDir(projectId, threadId), META_FILE))) count += 1
  }
  return count
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

function catalogEntryOf(thread: Thread): CatalogEntry | null {
  // Archived threads leave the `@`-picker index; the directory stays on disk.
  if (thread.archivedAt != null) return null
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
      const value = parseJsonUnknown(line)
      if (
        !isRecord(value) ||
        typeof value['id'] !== 'string' ||
        typeof value['title'] !== 'string' ||
        typeof value['createdAt'] !== 'number' ||
        typeof value['updatedAt'] !== 'number' ||
        typeof value['digest'] !== 'string' ||
        typeof value['path'] !== 'string'
      ) {
        continue
      }
      const entry: CatalogEntry = {
        id: value['id'],
        title: value['title'],
        createdAt: value['createdAt'],
        updatedAt: value['updatedAt'],
        digest: value['digest'],
        path: value['path'],
      }
      map.set(entry.id, entry)
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
  // If the index file is missing, rebuild from dirs first so an external seed
  // (thread dirs without catalog.jsonl) is not collapsed to this one entry.
  // Incomplete-but-present files are healed on read via {@link ensureCatalogMap}.
  const entries = existsSync(catalogPath(projectId))
    ? readCatalog(projectId)
    : rebuildCatalogFromDisk(projectId)
  const entry = catalogEntryOf(thread)
  if (entry === null) entries.delete(thread.id)
  else entries.set(thread.id, entry)
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
  // Soft-archived threads drop out of the `@`-picker index.
  if (meta.archivedAt != null) return null
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
  const entries = existsSync(catalogPath(projectId))
    ? readCatalog(projectId)
    : rebuildCatalogFromDisk(projectId)
  const entry = catalogEntryFromDisk(projectId, threadId)
  if (entry === null) {
    // Missing meta or archived — drop any stale catalog line.
    if (entries.delete(threadId)) writeCatalog(projectId, entries)
    return
  }
  entries.set(threadId, entry)
  writeCatalog(projectId, entries)
}

/**
 * Rebuild `catalog.jsonl` from on-disk thread dirs (O(threads), no full fold).
 * Used when the index is missing or was partially written by a single-thread
 * upsert/refresh before a full rebuild — see {@link ensureCatalogMap}.
 */
function rebuildCatalogFromDisk(projectId: string): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>()
  for (const threadId of listThreadIds(projectId)) {
    const entry = catalogEntryFromDisk(projectId, threadId)
    if (entry) entries.set(threadId, entry)
  }
  writeCatalog(projectId, entries)
  return entries
}

/** True when an on-disk, non-archived thread is absent from the catalog map. */
function catalogMissingIndexedThreads(
  projectId: string,
  entries: Map<string, CatalogEntry>,
): boolean {
  for (const threadId of listThreadIds(projectId)) {
    if (entries.has(threadId)) continue
    if (catalogEntryFromDisk(projectId, threadId) !== null) return true
  }
  return false
}

/**
 * Read the project catalog, rebuilding from thread dirs when the file is
 * missing **or** incomplete. A lone `upsertCatalogEntry` /
 * `refreshCatalogLine` after an external seed (e2e fixtures, import) used to
 * write a one-line `catalog.jsonl` from an empty read — after that,
 * `loadProjectCatalog` trusted the file and the `@`-picker hid every other
 * thread even though the sidebar still listed them from the dirs.
 */
function ensureCatalogMap(projectId: string): Map<string, CatalogEntry> {
  if (!existsSync(catalogPath(projectId))) return rebuildCatalogFromDisk(projectId)
  const entries = readCatalog(projectId)
  if (catalogMissingIndexedThreads(projectId, entries)) {
    return rebuildCatalogFromDisk(projectId)
  }
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
      const value = parseJsonUnknown(line)
      if (
        !isRecord(value) ||
        typeof value['prUrl'] !== 'string' ||
        typeof value['threadId'] !== 'string' ||
        typeof value['agentId'] !== 'string' ||
        !isRemoteAgentProvider(value['provider'])
      ) {
        continue
      }
      const entry: RemoteAgentPrIndexEntry = {
        prUrl: value['prUrl'],
        threadId: value['threadId'],
        agentId: value['agentId'],
        provider: value['provider'],
      }
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

/** A fully folded thread, serialized with writes for an authoritative blank-thread check. */
export function getProjectThread(projectId: string, threadId: string): Promise<Thread | null> {
  return runSerialized(queueKey(projectId), () => readThread(projectId, threadId))
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

export function loadProjectThreads(
  projectId: string,
  options: ThreadLoadOptions = {},
): Promise<Thread[]> {
  return runSerialized(queueKey(projectId), () => readProjectThreads(projectId, options))
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
      const entry = catalogEntryOf(thread)
      if (entry) entries.set(thread.id, entry)
    }
    for (const threadId of listThreadIds(projectId)) {
      if (!keepIds.has(threadId)) {
        const dir = threadDir(projectId, threadId)
        rmSync(dir, { recursive: true, force: true })
        invalidateKnownMessageIds(dir)
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
 * Persist one finalized message: its OKF/blob files, then its spine line. A
 * brand-new message id (the common case) is a true append — no read, parse,
 * or re-serialization of the rest of the spine, using the {@link
 * knownMessageIdsFor} cache to tell new ids from re-finalized ones without
 * paying an O(n) parse per call (#1222). A re-finalized/edited message id
 * (rare) still replaces its existing line in place, working on verbatim spine
 * entries so non-message lines (hook_run and unknown future types) keep their
 * exact bytes and positions. Writing files before the spine keeps a crash
 * from leaving the spine pointing at a missing file. `meta.json` is left to
 * `updateMeta` — the renderer bumps `updatedAt` through it around the same
 * time.
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
    const raw = serializeSpineLine(line)
    const knownIds = knownMessageIdsFor(dir)
    if (!knownIds.has(message.id)) {
      appendFileSync(join(dir, EVENTS_FILE), `${raw}\n`)
      knownIds.add(message.id)
      return
    }
    const entries = parseSpineEntries(safeRead(join(dir, EVENTS_FILE)) ?? '')
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

/** One blob a `hook_run` line points at; `text` is null when it is gone from disk. */
export interface StoredHookRunBlob {
  ref: string
  text: string | null
}

/** A `hook_run` line plus the bodies it references — the raw record behind a hook card. */
export interface StoredHookRun {
  line: SpineHookRunLine
  payload: StoredHookRunBlob | null
  stdout: StoredHookRunBlob | null
  stderr: StoredHookRunBlob | null
  outcome: StoredHookRunBlob | null
}

/**
 * Read one hook execution back out of a thread's spine, by its `hook_run` id.
 * Backs the hook-card inspector: the transcript carries only the compact card,
 * so the bodies (stdin payload, raw streams, applied outcome) are fetched on
 * demand — the store stays the single source of truth and history never grows a
 * second copy of a hook's output.
 *
 * Returns null when no such run is recorded — an id from a live card whose spine
 * append has not landed yet, or a thread whose store was pruned. Each blob is
 * read independently so a missing file degrades to `text: null` on that one
 * stream rather than losing the whole record.
 */
export function readHookRun(
  projectId: string,
  threadId: string,
  runId: string,
): Promise<StoredHookRun | null> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    const raw = safeRead(join(dir, EVENTS_FILE))
    if (raw === null) return null
    let line: SpineHookRunLine | null = null
    for (const entry of parseSpineEntries(raw)) {
      if (entry.line?.type === 'hook_run' && entry.line.id === runId) line = entry.line
    }
    if (!line) return null
    // Refs are app-written, but they are still data read back off disk: keep the
    // read inside the thread's own blobs dir so a corrupted spine line can never
    // turn an inspector open into an arbitrary file read.
    const blob = (ref: ContentRef | undefined): StoredHookRunBlob | null => {
      if (!ref) return null
      const isThreadBlob = ref.ref.startsWith('blobs/') && !ref.ref.includes('..')
      return { ref: ref.ref, text: isThreadBlob ? safeRead(join(dir, ref.ref)) : null }
    }
    return {
      line,
      payload: blob(line.payload),
      stdout: blob(line.stdout),
      stderr: blob(line.stderr),
      outcome: blob(line.outcome),
    }
  })
}

/** Append one durable Guarded YOLO shell authorization record. */
export function appendPermissionDecision(
  projectId: string,
  threadId: string,
  line: SpinePermissionDecisionLine,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    mkdirSync(dir, { recursive: true })
    const existingRaw = safeRead(join(dir, EVENTS_FILE)) ?? ''
    const prefix =
      existingRaw === '' || existingRaw.endsWith('\n') ? existingRaw : `${existingRaw}\n`
    writeFileSync(join(dir, EVENTS_FILE), `${prefix}${serializeSpineLine(line)}\n`)
  })
}

/** Append one compact machine-continuation audit record. */
export function appendMachineContinuation(
  projectId: string,
  threadId: string,
  line: SpineMachineContinuationLine,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    mkdirSync(dir, { recursive: true })
    const existingRaw = safeRead(join(dir, EVENTS_FILE)) ?? ''
    const prefix =
      existingRaw === '' || existingRaw.endsWith('\n') ? existingRaw : `${existingRaw}\n`
    writeFileSync(join(dir, EVENTS_FILE), `${prefix}${serializeSpineLine(line)}\n`)
  })
}

/** Append one stream-cut observability record (project-level eval source). */
export function appendStreamStat(projectId: string, line: unknown): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const path = streamStatsPath(projectId)
    mkdirSync(dirname(path), { recursive: true })
    const existingRaw = safeRead(path) ?? ''
    const prefix =
      existingRaw === '' || existingRaw.endsWith('\n') ? existingRaw : `${existingRaw}\n`
    writeFileSync(path, `${prefix}${JSON.stringify(line)}\n`)
  })
}

/** Append one reasoning-checkpoint decision (project-level eval source). */
export function appendReasoningCheckpoint(projectId: string, line: unknown): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const path = reasoningCheckpointsPath(projectId)
    mkdirSync(dirname(path), { recursive: true })
    const existingRaw = safeRead(path) ?? ''
    const prefix =
      existingRaw === '' || existingRaw.endsWith('\n') ? existingRaw : `${existingRaw}\n`
    writeFileSync(path, `${prefix}${JSON.stringify(line)}\n`)
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

/** Patch metadata, failing if the renderer has not persisted the thread yet. */
export function updateMetaOrThrow(
  projectId: string,
  threadId: string,
  patch: Partial<ThreadMeta>,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    if (current === null) throw new Error('Thread is not persisted yet; retry sending the message')
    const merged: ThreadMeta = { ...current, ...patch, id: threadId }
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(merged)}\n`)
    refreshCatalogLine(projectId, threadId)
  })
}

/**
 * Forget a thread's linked checkout after that checkout has been removed from
 * disk. `updateMeta` cannot express this: it merges a patch, and an absent
 * worktree has to actually leave `meta.json`. Without it the thread is bricked
 * — {@link import('./thread-checkout-transaction.ts')} validates recorded
 * worktree metadata on every send and deliberately never falls back to shared
 * mode. Dropping the field (and keeping `worktreeChoice`) lets the thread carry
 * on in the project checkout instead. Returns false when there was nothing to
 * clear, so callers can tell a no-op from a real reversion.
 */
export function clearThreadWorktree(projectId: string, threadId: string): Promise<boolean> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    if (current === null || current.worktree === undefined) return false
    const { worktree: _removed, ...rest } = current
    writeFileSync(join(dir, META_FILE), `${JSON.stringify({ ...rest, id: threadId })}\n`)
    refreshCatalogLine(projectId, threadId)
    return true
  })
}

export function deleteProjectThread(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    rmSync(dir, { recursive: true, force: true })
    invalidateKnownMessageIds(dir)
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

// --- Provider-format agent history sidecar (issue #993) ---------------------
//
// Snapshot (not append-only): context trimming replaces the whole history.
// Always addressed by trusted `(projectId, threadId)` — never by a globally
// unique threadId assumption.

function agentHistoryPath(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), AGENT_HISTORY_FILE)
}

function agentEpochPath(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), AGENT_EPOCH_FILE)
}

/**
 * A thread's blob directory — verbatim tool results, images, and the videos a
 * user attaches to the chat. It sits inside the chat store, which the agent's
 * read tools already treat as a readable root, so a stored video is addressable
 * by absolute path without granting any new filesystem authority.
 */
export function threadBlobsDir(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), 'blobs')
}

/** Ceiling on a thread-directory snapshot, so an export cannot exhaust memory. */
export const MAX_THREAD_DIRECTORY_BYTES = 512 * 1024 * 1024

export interface ThreadDirectoryFile {
  /** Path relative to the thread directory, POSIX-separated. */
  path: string
  data: Uint8Array
  modifiedAt: Date
}

/**
 * Snapshot every file in a thread's directory — meta, spine, OKF prose, blobs,
 * plans and nested subagents, exactly as they sit on disk. Backs the "export
 * the whole thread folder" download, which is a superset of the portable JSONL
 * export. Runs on the project's write queue so the snapshot cannot catch a save
 * mid-flight, and refuses anything over `MAX_THREAD_DIRECTORY_BYTES` rather
 * than pulling an unbounded amount of blob data into memory.
 */
export function readThreadDirectory(
  projectId: string,
  threadId: string,
): Promise<ThreadDirectoryFile[]> {
  return runSerialized(queueKey(projectId), async () => {
    const dir = threadDir(projectId, threadId)
    if (!existsSync(join(dir, META_FILE))) {
      throw new Error(`No stored thread directory for ${threadId}`)
    }
    const dirents = await readdir(dir, { withFileTypes: true, recursive: true })
    // `isFile()` reflects lstat, so a symlink is skipped rather than followed
    // out of the store.
    const paths = dirents
      .filter((dirent) => dirent.isFile())
      .map((dirent) => relative(dir, join(dirent.parentPath, dirent.name)).split(sep).join('/'))
      .sort()
    const files: ThreadDirectoryFile[] = []
    let total = 0
    for (const path of paths) {
      const full = join(dir, path)
      const stats = await stat(full)
      total += stats.size
      if (total > MAX_THREAD_DIRECTORY_BYTES) {
        throw new Error('This thread is too large to export as an archive')
      }
      files.push({ path, data: await readFile(full), modifiedAt: stats.mtime })
    }
    return files
  })
}

/** Load provider history for a thread. Missing/corrupt/future-version → `[]`. */
export function loadAgentHistory(projectId: string, threadId: string): Promise<LLMMessage[]> {
  return runSerialized(queueKey(projectId), () => {
    const raw = safeRead(agentHistoryPath(projectId, threadId))
    if (raw === null) return []
    return parseAgentHistoryFile(raw) ?? []
  })
}

/** Atomically replace the provider-history snapshot for a thread. */
export function saveAgentHistory(
  projectId: string,
  threadId: string,
  messages: LLMMessage[],
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    mkdirSync(dir, { recursive: true })
    // Images a tool produced (video frames) are regenerable from the paths its
    // text result names, so they never reach the sidecar — see
    // `stripToolResultImages` for why that matters to file size.
    const body = `${JSON.stringify({ v: AGENT_HISTORY_VERSION, messages: stripToolResultImages(messages) })}\n`
    atomicWriteFile(join(dir, AGENT_HISTORY_FILE), body)
  })
}

/** Load the latest durable machine-continuation epoch for a thread. */
export function loadAgentTurnEpoch(
  projectId: string,
  threadId: string,
): Promise<AgentTurnEpoch | null> {
  return runSerialized(queueKey(projectId), () => {
    const raw = safeRead(agentEpochPath(projectId, threadId))
    if (raw === null) return null
    try {
      const value = parseJsonUnknown(raw)
      if (!isRecord(value)) return null
      const turnTreeId = value['turnTreeId']
      const continuationUsed = value['continuationUsed']
      if (
        typeof turnTreeId !== 'string' ||
        turnTreeId.length === 0 ||
        typeof continuationUsed !== 'number' ||
        !Number.isInteger(continuationUsed) ||
        continuationUsed < 0
      ) {
        return null
      }
      return { turnTreeId, continuationUsed }
    } catch {
      return null
    }
  })
}

/** Persist the current turn-tree epoch before machine work can rely on it. */
export function saveAgentTurnEpoch(
  projectId: string,
  threadId: string,
  epoch: AgentTurnEpoch,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    if (readMeta(dir) === null) return
    atomicWriteFile(join(dir, AGENT_EPOCH_FILE), `${JSON.stringify(epoch)}\n`)
  })
}

/** Remove the provider-history sidecar (clear-history / fresh resume). */
export function clearAgentHistory(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    for (const path of [
      agentHistoryPath(projectId, threadId),
      agentEpochPath(projectId, threadId),
    ]) {
      if (!existsSync(path)) continue
      try {
        unlinkSync(path)
      } catch {
        // Best-effort: a missing file is the desired end state.
      }
    }
  })
}

/** True when an `agent-history.json` sidecar already exists for the thread. */
export function agentHistoryExists(projectId: string, threadId: string): Promise<boolean> {
  return runSerialized(queueKey(projectId), () => existsSync(agentHistoryPath(projectId, threadId)))
}

// --- External ACP session sidecar -------------------------------------------

function acpSessionBindingPath(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), ACP_SESSION_FILE)
}

/**
 * Load an exact external-agent binding. Missing, corrupt, unknown-version, or
 * structurally invalid files fail closed to `null`; callers then require a new
 * session or explicit recovery rather than guessing from `session/list`.
 */
export function loadAcpSessionBinding(
  projectId: string,
  threadId: string,
): Promise<AcpSessionBinding | null> {
  return runSerialized(queueKey(projectId), () => {
    const raw = safeRead(acpSessionBindingPath(projectId, threadId))
    if (raw === null) return null
    return safeJsonParse(raw, decodeWithSchema(acpSessionBindingSchema))
  })
}

/** Atomically persist a private exact-session binding before the first prompt. */
export function saveAcpSessionBinding(
  projectId: string,
  threadId: string,
  binding: AcpSessionBinding,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = threadDir(projectId, threadId)
    mkdirSync(dir, { recursive: true })
    atomicWriteFile(join(dir, ACP_SESSION_FILE), `${JSON.stringify(binding)}\n`, 0o600)
  })
}

/** Remove a confirmed-stale or explicitly abandoned external ACP binding. */
export function clearAcpSessionBinding(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const path = acpSessionBindingPath(projectId, threadId)
    if (!existsSync(path)) return
    try {
      unlinkSync(path)
    } catch {
      // Best-effort: a missing file is the desired end state.
    }
  })
}

/**
 * Project store ids that own a thread directory for `threadId` (have
 * `meta.json`). Used by the #993 legacy `llm-history:*` migration to resolve
 * exactly one owner before writing a sidecar.
 */
export function findThreadOwners(threadId: string): Promise<string[]> {
  return runSerialized('thread-store:owners', () => {
    const owners: string[] = []
    for (const projectId of listProjectStoreIds()) {
      if (existsSync(join(threadDir(projectId, threadId), META_FILE))) {
        owners.push(projectId)
      }
    }
    return owners
  })
}

/**
 * Catalog entries for a project, newest first, optionally filtered by a query.
 * Each hit carries its absolute `events.jsonl` path (resolved here, not stored)
 * so the `@`-thread picker can hand the agent an absolute reference.
 */
export function loadProjectCatalog(projectId: string, query?: string): Promise<ThreadCatalogHit[]> {
  return runSerialized(queueKey(projectId), () => {
    const map = ensureCatalogMap(projectId)
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

/**
 * Store directories with threads but no matching project entry — the invisible
 * orphans from issue #997. `knownProjectIds` are the ids currently in config; a
 * store id not among them (and holding at least one thread) is surfaced so it
 * can be re-attached. Empty stores are skipped (nothing to recover).
 */
export function listOrphanProjectStores(
  knownProjectIds: string[],
): Promise<import('@shared/types').OrphanProjectStore[]> {
  const known = new Set(knownProjectIds)
  return runSerialized('thread-store:orphans', () => {
    const orphans: import('@shared/types').OrphanProjectStore[] = []
    for (const id of listProjectStoreIds()) {
      if (known.has(id)) continue
      const threadCount = countThreadDirs(id)
      if (threadCount > 0) orphans.push({ id, threadCount })
    }
    return orphans
  })
}

/**
 * Load every thread across all projects (usage summaries, etc.).
 *
 * Must go through {@link loadProjectThreads} (the per-project write queue), not
 * {@link readProjectThreads} directly: once reads are async and yield to the
 * event loop, an unqueued load can interleave with `saveProjectThread` and
 * observe a torn thread directory.
 */
export async function loadAllProjectThreads(): Promise<Thread[]> {
  const projects = recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
    const id = project['id']
    return typeof id === 'string' && id.length > 0 ? [{ id }] : []
  })
  const threads: Thread[] = []
  for (const project of projects) {
    threads.push(...(await loadProjectThreads(project.id)))
  }
  return threads
}
