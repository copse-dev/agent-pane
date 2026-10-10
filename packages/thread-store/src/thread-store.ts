import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync as writeRawFileSync,
  constants,
  openSync,
  closeSync,
} from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import type {
  Message,
  OrphanProjectStore,
  Thread,
  ThreadCatalogEntry,
  ThreadCatalogHit,
  ThreadLink,
} from './thread-types.ts'
import { sortThreadsNewestFirst } from './thread-sort.ts'
import { stripToolResultImages } from '@copse/llm/tool-result-images.ts'
import {
  attachHookCards,
  explodeMessage,
  explodeThread,
  foldThread,
  refsOfLine,
  type FileToWrite,
  type RefResolver,
} from './fold.ts'
import { parseOkfMessage } from './okf-message.ts'
import { parseThreadMetaValue, parseThreadValue } from './thread-boundary.ts'
import {
  parseSpine,
  parseSpineEntries,
  rebuildSpinePreservingNonMessageLines,
  serializeSpineEntries,
  serializeSpineLine,
  type ContentRef,
  type SpineHookRunLine,
  type SpineMachineContinuationLine,
  type SpineModelSelectedLine,
  type SpineContextCompactionLine,
  type SpineDecisionLine,
  type SpinePermissionDecisionLine,
  type ThreadMeta,
} from './spine-schema.ts'
import {
  remoteAgentPrIndexKey,
  isImportedCursorAgentThread,
  type RemoteAgentLink,
  type RemoteAgentPrIndexEntry,
} from './remote-agent-link.ts'
import type { GithubPrRef } from './github-pr-url.ts'
import type { ModelSelectionEvent } from './thread-types.ts'
import { isRemoteAgentProvider } from './remote-agent-provider.ts'
import {
  extractGithubPrUrls,
  githubPrKey,
  githubPrKeyMatchesTerm,
  githubRepoKey,
} from './github-pr-url.ts'
import { collectThreadPrRefs } from './thread-pr-status.ts'
import {
  backlinksFor,
  extractThreadLinks,
  mergeThreadLinks,
  type ThreadBacklink,
} from './thread-links.ts'
import { isRecord, parseJsonUnknown } from '@copse/std/unknown-value.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { z } from 'zod'
import {
  ThreadPrRelationshipIndex,
  prProductionSchema,
  commitProductionSchema,
  type PrProduction,
  type CommitProduction,
  type PrThreadRelationship,
} from './thread-pr-relations.ts'
import {
  resolveProjectDir,
  resolveStrictlyInside,
  resolveInsideWithoutSymlinks,
  threadStoreEnvironment,
} from './environment.ts'
import { runSerialized } from './write-queue.ts'
import { isNonNull } from '@copse/std/nullish.ts'
import { SqliteThreadIndex, THREAD_INDEX_FILE } from './sqlite-thread-index.ts'

/**
 * Filesystem-native thread store (issue #644). Each thread is a self-contained
 * directory under `~/.copse/workspace/<projectId>/<threadId>/`:
 *
 *   meta.json           mutable thread metadata (everything except messages)
 *   events.jsonl        append-only spine, one line per finalized message
 *   agent-history.json  provider-format LLM resume snapshot (issue #993)
 *   acp-session.json    private external-agent session binding
 *   acp-debug.jsonl     opt-in ACP wire trace (COPSE_DEBUG_ACP_UPDATES=1 only)
 *   messages/*.md       OKF prose (message content + reasoning)
 *   blobs/*             tool results, oversized tool args, decision detail, images
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
const HISTORY_EDIT_TRANSACTION_FILE = 'history-edit-transaction.json'
const HISTORY_EDIT_UNDO_FILE = 'history-edit-undo.json'
const HISTORY_EDIT_VERSION = 1
const CATALOG_FILE = 'catalog.jsonl'
const AGENT_PR_INDEX_FILE = 'agent-pr-index-v2.jsonl'
const STREAM_STATS_FILE = 'stream-stats.jsonl'
const REASONING_CHECKPOINTS_FILE = 'reasoning-checkpoints.jsonl'
const CONTENT_DIRS = ['messages', 'blobs', 'subagents']
/** Directories a spine ref may point into (plan artifacts are refs but never pruned). */
const REF_DIRS = [...CONTENT_DIRS, 'plans']

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

function projectDir(projectId: string): string {
  return resolveProjectDir(threadStoreEnvironment().workspaceRoot(), projectId)
}

/** Root of the chat store, as the host configured it (see `environment.ts`). */
const workspaceRoot = (): string => threadStoreEnvironment().workspaceRoot()

/** Root of the chat store, for callers that need to authorise a path against it. */
export const chatStoreRoot = workspaceRoot

export interface AgentTurnEpoch {
  turnTreeId: string
  continuationUsed: number
}

function threadDir(projectId: string, threadId: string): string {
  const project = projectDir(projectId)
  const dir = resolveStrictlyInside(project, threadId)
  // A thread id names exactly one directory directly under its project.
  if (
    dir === null ||
    dirname(dir) !== project ||
    resolveInsideWithoutSymlinks(project, threadId) === null
  ) {
    throw new Error('Thread id resolves outside its project store')
  }
  return dir
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
  // `messagesLoaded` is in-memory bookkeeping about *this session's* load state.
  // Persisting it would write a field that is meaningless on the next launch.
  const { messages: _messages, messagesLoaded: _messagesLoaded, ...meta } = thread
  return meta
}

/**
 * Absolute path of a spine ref inside `dir`, or null when it would land outside
 * {@link REF_DIRS}. Refs are built from ids that model endpoints and ACP agents
 * supply, and on load they are read back from a spine file on disk, so every ref
 * is checked here before it touches the filesystem. Existing symlink components are rejected.
 */
function contentFilePath(dir: string, ref: string): string | null {
  const full = resolveInsideWithoutSymlinks(dir, ref)
  if (full === null) return null
  const [top, ...rest] = relative(resolvePath(dir), full).split(sep)
  return top !== undefined && REF_DIRS.includes(top) && rest.length > 0 ? full : null
}

/** {@link contentFilePath} for a write: an escaping ref fails the whole write. */
function contentFilePathForWrite(dir: string, ref: string): string {
  const full = contentFilePath(dir, ref)
  if (full === null) throw new Error('Refusing to write a thread file outside its directory')
  return full
}

/** Guard store paths again at I/O; no-follow opens also protect the leaf. */
function assertStorePath(path: string): void {
  const root = threadStoreEnvironment().workspaceRoot()
  if (resolveInsideWithoutSymlinks(root, relative(resolvePath(root), resolvePath(path))) === null) {
    throw new Error('Refusing a thread-store path with an unsafe or symlink component')
  }
}

function writeStoreFileSync(path: string, data: string, mode?: number): void {
  assertStorePath(path)
  markIndexSourceWrite(path)
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    mode,
  )
  try {
    writeRawFileSync(fd, data)
  } finally {
    closeSync(fd)
  }
}

async function writeStoreFileAsync(path: string, data: string, mode?: number): Promise<void> {
  assertStorePath(path)
  markIndexSourceWrite(path)
  await fsPromises.writeFile(path, data, {
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    ...(mode === undefined ? {} : { mode }),
  })
}

function writeFileEnsuringDir(fullPath: string, contents: string): void {
  assertStorePath(fullPath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeStoreFileSync(fullPath, contents)
}

async function writeFileEnsuringDirAsync(fullPath: string, contents: string): Promise<void> {
  assertStorePath(fullPath)
  await fsPromises.mkdir(dirname(fullPath), { recursive: true })
  await writeStoreFileAsync(fullPath, contents)
}

/**
 * Append one JSONL record without reading or rewriting the existing file.
 * App-written files already end in a newline; the one-byte read only repairs a
 * legacy/truncated final line before the new record is appended.
 */
async function appendJsonlLine(path: string, line: string): Promise<void> {
  assertStorePath(path)
  await fsPromises.mkdir(dirname(path), { recursive: true })
  assertStorePath(path)
  markIndexSourceWrite(path)
  const handle = await fsPromises.open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
  )
  try {
    const { size } = await handle.stat()
    let prefix = ''
    if (size > 0) {
      const lastByte = Buffer.allocUnsafe(1)
      const { bytesRead } = await handle.read(lastByte, 0, 1, size - 1)
      if (bytesRead === 1 && lastByte[0] !== 0x0a) prefix = '\n'
    }
    await handle.appendFile(`${prefix}${line}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

/** Atomic replace so a crash never leaves a half-written sidecar. */
function atomicWriteFile(path: string, data: string, mode?: number): void {
  assertStorePath(path)
  const tmp = `${path}.copse-${String(process.pid)}.tmp`
  if (mode === undefined) writeStoreFileSync(tmp, data)
  else writeStoreFileSync(tmp, data, mode)
  markIndexSourceWrite(path)
  renameSync(tmp, path)
}

/** Async atomic replace with an operation-unique temp path, safe across yielded writes. */
async function atomicWriteFileAsync(path: string, data: string, mode?: number): Promise<void> {
  assertStorePath(path)
  const tmp = `${path}.copse-${String(process.pid)}-${randomUUID()}.tmp`
  try {
    if (mode === undefined) await writeStoreFileAsync(tmp, data)
    else await writeStoreFileAsync(tmp, data, mode)
    markIndexSourceWrite(path)
    await fsPromises.rename(tmp, path)
  } catch (error) {
    await fsPromises.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
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
const providerStateMessageSchema = z.object({
  role: z.literal('provider_state'),
  state: z.object({
    kind: z.literal('openai-responses-compaction'),
    v: z.literal(1),
    model: z.string().min(1),
    endpoint: z.string(),
    itemId: z.string().min(1),
    encryptedContent: z.string().min(1),
  }),
})

function parseAgentHistoryFile(raw: string): LLMMessage[] | null {
  const parsed = safeJsonParse(
    raw,
    decodeWithSchema(
      z.object({ v: z.literal(AGENT_HISTORY_VERSION), messages: z.array(z.unknown()) }),
    ),
  )
  if (!parsed) return null
  const messages: LLMMessage[] = []
  for (const message of parsed.messages) {
    if (isRecord(message) && message['role'] === 'provider_state') {
      // Invalid opaque state must not break the retained neutral fallback.
      const decoded = providerStateMessageSchema.safeParse(message)
      if (decoded.success) messages.push(decoded.data)
    } else {
      if (!isAgentHistoryMessage(message)) return null
      messages.push(message)
    }
  }
  return messages
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
async function knownMessageIdsFor(dir: string): Promise<Set<string>> {
  const cached = knownMessageIdsByDir.get(dir)
  if (cached) return cached
  const eventsPath = join(dir, EVENTS_FILE)
  const raw = (await readOrNull(eventsPath)) ?? ''
  if (raw !== '' && !raw.endsWith('\n')) {
    // Normalize a legacy file with no trailing newline before switching to
    // true appends below, which assume one is already there.
    await writeStoreFileAsync(eventsPath, `${raw}\n`)
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
  for (const contentDir of REF_DIRS) assertStorePath(join(dir, contentDir))
  mkdirSync(dir, { recursive: true })

  const { spine, files } = explodeThread(thread.messages, sha256)
  // Resolve every path before writing any, so a bad ref leaves nothing behind.
  const targets = files.map((file) => ({
    path: contentFilePathForWrite(dir, file.ref),
    contents: file.contents,
  }))
  for (const target of targets) writeFileEnsuringDir(target.path, target.contents)
  const existingRaw = safeRead(join(dir, EVENTS_FILE)) ?? ''
  const { body, preservedRefs } = rebuildSpinePreservingNonMessageLines(existingRaw, spine)
  writeStoreFileSync(join(dir, EVENTS_FILE), body)
  const previous = readMeta(dir)
  writeStoreFileSync(
    join(dir, META_FILE),
    `${JSON.stringify({
      ...metaOf(thread),
      ...(previous?.prProductions ? { prProductions: previous.prProductions } : {}),
      ...(previous?.commitProductions ? { commitProductions: previous.commitProductions } : {}),
    })}\n`,
  )
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
async function mapConcurrent<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number = READ_CONCURRENCY,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
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

async function readOrNull(path: string, strict = false): Promise<string | null> {
  try {
    assertStorePath(path)
    const handle = await fsPromises.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (strict && !(isRecord(error) && error['code'] === 'ENOENT')) throw error
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
    // A ref outside the thread's ref dirs is never read: it stays absent,
    // so the fold fails with `Missing thread file` and the thread is skipped.
    const nestedSpines = await mapConcurrent(nested, async (prefix) => {
      const path = contentFilePath(dir, prefix + EVENTS_FILE)
      return { prefix, raw: path === null ? null : await readOrNull(path) }
    })
    await mapConcurrent(fileRefs, async (ref) => {
      const path = contentFilePath(dir, ref)
      const body = path === null ? null : await readOrNull(path)
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
 * show. `includeArchived` defaults to true so whole-history readers, agent
 * discovery, and metadata-only all-time usage totals remain complete; the
 * renderer's `threads:load-project` opts out.
 */
export interface ThreadLoadOptions {
  includeArchived?: boolean
}

async function readThread(
  projectId: string,
  threadId: string,
  options: ThreadLoadOptions = {},
  strict = false,
): Promise<Thread | null> {
  recoverPendingHistoryEdit(projectId, threadId)
  const dir = threadDir(projectId, threadId)
  const [metaRaw, eventsRaw] = await Promise.all([
    readOrNull(join(dir, META_FILE), strict),
    readOrNull(join(dir, EVENTS_FILE), strict),
  ])
  const meta = parseMeta(metaRaw)
  if (meta === null) return null
  // Bail before the prefetch: skipping an archived thread is only worth doing if
  // its message bodies are never read, and that is where the bytes are.
  if (options.includeArchived === false && meta.archivedAt != null) return null

  const raw = eventsRaw ?? ''
  const entries = parseSpineEntries(raw)
  const spine = parseSpine(raw)
  // DEBUG BRANCH: `prefetchThreadFiles` is where the bytes are — one read per
  // referenced message/blob file. Counted rather than spanned: at hundreds of
  // threads a span each would swamp the trace, while the totals (calls, ms,
  // bytes) are what actually identify the cost.
  const prefetchStart = process.hrtime.bigint()
  const contents = await prefetchThreadFiles(dir, raw)
  let prefetchedBytes = 0
  for (const body of contents.values()) prefetchedBytes += body.length
  threadStoreEnvironment().perf.count(
    'store:thread-prefetch',
    Number(process.hrtime.bigint() - prefetchStart) / 1e6,
    prefetchedBytes + raw.length,
  )
  const resolve: RefResolver = (ref) => {
    const body = contents.get(ref)
    if (body === undefined) throw new Error(`Missing thread file: ${ref}`)
    return body
  }
  try {
    const thread = foldThread(meta, spine, resolve, {
      hash: sha256,
      onIntegrityFailure: (ref) => {
        console.warn(
          `[thread-store] Thread ${threadId}: ${ref} failed its hash check; showing that tool call as unavailable`,
        )
      },
    })
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
    assertStorePath(path)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
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

/**
 * Read only what the sidebar draws: `meta.json`, plus a `stat` of the spine to
 * tell a genuinely empty thread from one whose transcript is merely unread.
 * That distinction is why this stats the spine rather than skipping it entirely
 * — `isBlankThread` and the autosave reconciler between them delete threads that
 * look blank, so "no messages" and "messages not loaded" must not be conflated.
 *
 * Cost per thread is one small read and one stat, against the old path's two
 * reads plus a file read per referenced message and blob, a full fold, and a
 * SHA-256 per ref.
 */
async function readThreadMetaOnly(
  projectId: string,
  threadId: string,
  options: ThreadLoadOptions = {},
  strict = false,
): Promise<Thread | null> {
  const dir = threadDir(projectId, threadId)
  const meta = parseMeta(await readOrNull(join(dir, META_FILE), strict))
  if (meta === null) return null
  if (options.includeArchived === false && meta.archivedAt != null) return null
  let spineBytes = 0
  try {
    spineBytes = (await fsPromises.stat(join(dir, EVENTS_FILE))).size
  } catch (error) {
    if (strict && !(isRecord(error) && error['code'] === 'ENOENT')) throw error
    // No spine file at all — a brand-new thread with nothing written yet.
  }
  // An empty spine means the transcript really is empty, and saying so lets
  // blank-thread pruning keep working exactly as before for new threads.
  return { ...meta, messages: [], messagesLoaded: spineBytes === 0 }
}

/**
 * Union this message's PR links into the thread's cached `prRefs`.
 *
 * Append-only: a link mentioned once stays linked even if a later edit removes
 * the text, which matches how the chip behaved when it re-scraped the whole
 * transcript every time. Silent on failure — a missing chip must never fail a
 * message write.
 */
function mergeGithubPrRefs(
  existing: readonly GithubPrRef[],
  found: readonly GithubPrRef[],
): { refs: GithubPrRef[]; added: boolean } {
  const refs = [...existing]
  const seen = new Set(refs.map(githubPrKey))
  let added = false
  for (const ref of found) {
    const key = githubPrKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
    added = true
  }
  return { refs, added }
}

/**
 * The shared read-merge-write for `prRefs`, with no queueing of its own. Callers
 * must either hold the project's write queue already ({@link mergePrRefsIntoMeta}
 * runs inside `appendMessage`'s queued op, where re-entering `runStoreWrite`
 * would deadlock) or wrap it themselves ({@link recordThreadPrRefs}).
 */
async function mergePrRefsIntoMetaUnqueued(
  projectId: string,
  threadId: string,
  found: readonly GithubPrRef[],
  foundLinks: readonly ThreadLink[] = [],
): Promise<GithubPrRef[] | null> {
  if (found.length === 0 && foundLinks.length === 0) return null
  const path = join(threadDir(projectId, threadId), META_FILE)
  const meta = parseMeta(await readOrNull(path))
  if (meta === null) return null
  const { refs, added } = mergeGithubPrRefs(meta.prRefs ?? [], found)
  // Links ride the same read-merge-write: one meta write per message, not two.
  const { links, added: linksAdded } = mergeThreadLinks(meta.links ?? [], foundLinks)
  if (!added && !linksAdded) return null
  await atomicWriteFileAsync(
    path,
    JSON.stringify(
      { ...meta, ...(added ? { prRefs: refs } : {}), ...(linksAdded ? { links } : {}) },
      null,
      2,
    ),
  )
  return added ? refs : null
}

/**
 * Union known PR refs into a thread's cached `prRefs` and report the result.
 *
 * This is the deterministic counterpart to {@link mergePrRefsIntoMeta}: a
 * caller that already holds the PR's coordinates — `gh_pr_create`, which just
 * opened it — records them directly instead of hoping the agent repeats the
 * URL in prose the scraper can parse. Returns the merged set when something
 * was added, so the caller can push the sidebar update, and null otherwise.
 * Queued via `runStoreWrite` like every other exported meta writer, so it
 * cannot interleave with a concurrent title/status/usage update and the
 * project's meta cache is invalidated when it lands.
 */
export function recordThreadPrRefs(
  projectId: string,
  threadId: string,
  found: readonly GithubPrRef[],
): Promise<GithubPrRef[] | null> {
  if (found.length === 0) return Promise.resolve(null)
  return runStoreWrite(projectId, () => mergePrRefsIntoMetaUnqueued(projectId, threadId, found))
}

/**
 * Recorded links are append-only. A renderer patch carries the renderer's copy,
 * which can lag a link the main process just recorded, so union rather than replace.
 */
function mergedLinksField(
  current: ThreadMeta,
  patch: Partial<ThreadMeta>,
): { links?: ThreadLink[] } {
  if (current.links === undefined && patch.links === undefined) return {}
  return { links: mergeThreadLinks(current.links ?? [], patch.links ?? []).links }
}

async function mergePrRefsIntoMeta(
  projectId: string,
  threadId: string,
  message: Message,
): Promise<void> {
  try {
    await mergePrRefsIntoMetaUnqueued(
      projectId,
      threadId,
      extractGithubPrUrls(message.content),
      extractThreadLinks(message.content),
    )
  } catch {
    // Diagnostic metadata; never worth failing the write it rides along with.
  }
}

/**
 * Fill in `prRefs` for legacy threads requested by visible sidebar rows.
 * The caller supplies a bounded page of ids; opening a project must not scan
 * every transcript just to populate chips for rows the user has not seen.
 * Cached and archived threads are skipped, and each successful scan records
 * even an empty result so later visits do not repeat the read.
 */
export function backfillThreadPrRefs(
  projectId: string,
  threadIds: readonly string[],
  onBatch: (refs: Array<{ threadId: string; prRefs: GithubPrRef[] }>) => void,
): Promise<void> {
  // Serialize batches across projects too, so overlapping viewport requests
  // cannot multiply the transcript-read concurrency limit below.
  return runSerialized('pr-ref-backfill:global', () =>
    backfillSelectedThreadPrRefs(projectId, threadIds, onBatch),
  )
}

async function backfillSelectedThreadPrRefs(
  projectId: string,
  threadIds: readonly string[],
  onBatch: (refs: Array<{ threadId: string; prRefs: GithubPrRef[] }>) => void,
): Promise<void> {
  const pending: string[] = []
  for (const threadId of new Set(threadIds)) {
    const meta = parseMeta(await readOrNull(join(threadDir(projectId, threadId), META_FILE), true))
    if (meta === null || meta.prRefs !== undefined || meta.archivedAt != null) continue
    pending.push(threadId)
  }
  if (pending.length === 0) return

  const batch: Array<{ threadId: string; prRefs: GithubPrRef[] }> = []
  const flush = (): void => {
    if (batch.length === 0) return
    onBatch([...batch])
    batch.length = 0
  }
  // Deliberately low concurrency: this runs while the user is working, and the
  // point of the whole change is to stop thread reads monopolising the loop.
  const failures = await mapConcurrent(
    pending,
    async (threadId) => {
      try {
        const thread = await readThread(projectId, threadId, {}, true)
        if (!thread) throw new Error(`Could not read thread ${threadId}`)
        const prRefs = collectThreadPrRefs(thread)
        // Transcript scanning stays concurrent and outside the foreground queue,
        // but the final read-merge-write joins the same per-project chain as every
        // other metadata mutation. Re-read at commit time so a title/status/usage
        // update that landed during the scan cannot be overwritten.
        const committedRefs = await runStoreWrite(projectId, async () => {
          const path = join(threadDir(projectId, threadId), META_FILE)
          const meta = parseMeta(await readOrNull(path, true))
          if (meta === null) return null
          const merged = mergeGithubPrRefs(meta.prRefs ?? [], prRefs)
          // Write even an empty list: `undefined` means "never scanned", `[]`
          // means "scanned, no PRs" — otherwise this would re-run forever.
          if (meta.prRefs === undefined || merged.added) {
            await atomicWriteFileAsync(
              path,
              JSON.stringify({ ...meta, prRefs: merged.refs }, null, 2),
            )
          }
          return merged.refs
        })
        // Empty refs also settle the renderer's "not scanned yet" state.
        if (committedRefs !== null) {
          batch.push({ threadId, prRefs: committedRefs })
        }
        if (batch.length >= 25) flush()
        return null
      } catch (error) {
        return { threadId, error }
      }
    },
    BACKFILL_CONCURRENCY,
  )
  flush()
  const failed = failures.filter(isNonNull)
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map(({ error }) => error),
      `Could not backfill PR refs for ${failed.map(({ threadId }) => threadId).join(', ')}`,
    )
  }
}

/** Keep transcript folding from competing heavily with foreground reads. */
const BACKFILL_CONCURRENCY = 2

/** The transcript for one thread, folded on demand when it is opened. */
export function loadThreadMessages(projectId: string, threadId: string): Promise<Message[]> {
  return runSerialized(queueKey(projectId), async () => {
    const thread = await readThread(projectId, threadId)
    return thread?.messages ?? []
  })
}

async function readProjectThreads(
  projectId: string,
  options: ThreadLoadOptions = {},
): Promise<Thread[]> {
  // DEBUG BRANCH: this is the whole-project read that `threads:load-project`
  // performs on every open and every switch back. It reads and folds each
  // non-archived thread in full — meta, spine, and every referenced message and
  // blob file — so its cost is a function of the project's entire chat history,
  // not of what the sidebar will actually display. Recording the directory count
  // alongside the surviving thread count separates "many threads" from "few but
  // enormous threads", which need different fixes.
  const threadIds = listThreadIds(projectId)
  return threadStoreEnvironment().perf.span(
    'store:read-project-threads',
    async () => {
      const loaded = await mapConcurrent(threadIds, (threadId) =>
        readThread(projectId, threadId, options),
      )
      return sortThreadsNewestFirst(loaded.filter(isNonNull))
    },
    (threads) => ({
      dirs: threadIds.length,
      returned: threads?.length ?? 0,
      includeArchived: options.includeArchived !== false,
    }),
  )
}

/**
 * Every thread's metadata, without any transcript. What the sidebar needs.
 *
 * Deliberately a separate function from {@link loadProjectThreads} rather than a
 * mode on it. Main-process callers such as release smoke, the automation
 * scheduler, cursor-agent discovery, and whole-history search genuinely want the
 * messages, and a load that quietly stopped returning them would break each in a
 * way no type checks: `messages` would simply be empty. The names now say which
 * one a caller is asking for.
 */
async function readProjectThreadMetas(
  projectId: string,
  options: ThreadLoadOptions = {},
  strict = false,
): Promise<Thread[]> {
  const threadIds = listThreadIds(projectId)
  return threadStoreEnvironment().perf.span(
    'store:read-project-metas',
    async () => {
      const loaded = await mapConcurrent(threadIds, (threadId) =>
        readThreadMetaOnly(projectId, threadId, options, strict),
      )
      return sortThreadsNewestFirst(loaded.filter(isNonNull))
    },
    (threads) => ({
      dirs: threadIds.length,
      returned: threads?.length ?? 0,
      includeArchived: options.includeArchived !== false,
    }),
  )
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
    prRefs: thread.prRefs ?? [],
  }
}

/**
 * Validate a catalog line's `prRefs`. Null (not `[]`) when the field is absent
 * or malformed, so the caller drops the line rather than indexing it as "this
 * thread has no PRs" — a line written before `prRefs` existed is stale, not
 * PR-free, and must be rebuilt from meta to become searchable by PR number.
 */
function parseCatalogPrRefs(value: unknown): GithubPrRef[] | null {
  if (!Array.isArray(value)) return null
  const refs: GithubPrRef[] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['owner'] !== 'string' ||
      typeof item['repo'] !== 'string' ||
      typeof item['number'] !== 'number' ||
      typeof item['url'] !== 'string'
    ) {
      return null
    }
    refs.push({
      owner: item['owner'],
      repo: item['repo'],
      number: item['number'],
      url: item['url'],
    })
  }
  return refs
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
      const prRefs = parseCatalogPrRefs(value['prRefs'])
      if (prRefs === null) continue
      const entry: CatalogEntry = {
        id: value['id'],
        title: value['title'],
        createdAt: value['createdAt'],
        updatedAt: value['updatedAt'],
        digest: value['digest'],
        path: value['path'],
        prRefs,
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
  writeStoreFileSync(catalogPath(projectId), sorted.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function upsertCatalogEntry(projectId: string, thread: Thread): void {
  // Read through {@link ensureCatalogMap}, not `readCatalog`: a missing file
  // (external seed — thread dirs without catalog.jsonl) or one whose lines this
  // build rejects wholesale (a pre-`prRefs` catalog) must rebuild from dirs
  // first, or writing back would collapse the index to this one entry.
  const entries = ensureCatalogMap(projectId)
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
  const path = contentFilePath(dir, line.content.ref)
  const raw = path === null ? null : safeRead(path)
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
    prRefs: meta.prRefs ?? [],
  }
}

function refreshCatalogLine(projectId: string, threadId: string): void {
  // Rebuild-on-read for the same reason as {@link upsertCatalogEntry}.
  const entries = ensureCatalogMap(projectId)
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
      if (key && typeof entry.threadId === 'string') map.set(`${key}\0${entry.threadId}`, entry)
    } catch {
      // Skip malformed line; the index is rebuildable.
    }
  }
  return map
}

function writeAgentPrIndex(projectId: string, entries: Map<string, RemoteAgentPrIndexEntry>): void {
  mkdirSync(projectDir(projectId), { recursive: true })
  const body = [...entries.values()].map((e) => JSON.stringify(e)).join('\n')
  writeStoreFileSync(agentPrIndexPath(projectId), body ? `${body}\n` : '')
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
  map.set(`${key}\0${threadId}`, {
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
  const normalizedRepo = repo?.toLowerCase()
  const candidates = normalizedRepo ? refs.filter((r) => githubRepoKey(r) === normalizedRepo) : refs
  const chosen = candidates.length > 0 ? candidates[candidates.length - 1] : undefined
  return chosen ? canonicalPrUrl(chosen) : undefined
}

// --- Public API (mirrors the former thread-persistence surface) -------------

const queueKey = (projectId: string): string => `thread-store:${projectId}`

// SQLite is a disposable, project-scoped projection. The existing decoded-meta
// LRU remains above it for project switches; relationship queries go straight to
// SQL and do not build a second all-project relationship map.
const threadIndexes = new Map<string, SqliteThreadIndex>()
const activeIndexDirs = new Set<string>()

function trimThreadIndexes(protectedDir?: string): void {
  while (threadIndexes.size > 16) {
    const oldest = [...threadIndexes.keys()].find(
      (dir) => dir !== protectedDir && !activeIndexDirs.has(dir),
    )
    if (oldest === undefined) return // Concurrent rebuilds are pinned until they settle.
    threadIndexes.get(oldest)?.close()
    threadIndexes.delete(oldest)
  }
}

function indexPaths(dir: string): string[] {
  const path = join(dir, THREAD_INDEX_FILE)
  return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
}

function discardThreadIndex(dir: string): void {
  threadIndexes.get(dir)?.close()
  threadIndexes.delete(dir)
  // Validate every path before removing any artifact. Never follow cache symlinks.
  const paths = indexPaths(dir)
  for (const path of paths) assertStorePath(path)
  for (const path of paths) rmSync(path, { force: true })
}

function openThreadIndex(dir: string): SqliteThreadIndex {
  for (const path of indexPaths(dir)) assertStorePath(path)
  const cached = threadIndexes.get(dir)
  if (cached && existsSync(join(dir, THREAD_INDEX_FILE))) {
    threadIndexes.delete(dir)
    threadIndexes.set(dir, cached)
    return cached
  }
  if (cached) {
    cached.close()
    threadIndexes.delete(dir)
  }
  let index: SqliteThreadIndex
  try {
    index = new SqliteThreadIndex(join(dir, THREAD_INDEX_FILE))
  } catch {
    discardThreadIndex(dir)
    index = new SqliteThreadIndex(join(dir, THREAD_INDEX_FILE))
  }
  threadIndexes.set(dir, index)
  trimThreadIndexes(dir)
  return index
}

function markIndexSourceWrite(path: string): void {
  if (basename(path) !== META_FILE && basename(path) !== EVENTS_FILE) return
  const parts = relative(resolvePath(workspaceRoot()), resolvePath(path)).split(sep)
  if (parts.length < 3) return
  const dir = dirname(dirname(path))
  if (!existsSync(join(dir, THREAD_INDEX_FILE))) return // No projection to stale yet.
  const threadId = basename(dirname(path))
  try {
    openThreadIndex(dir).markPending(threadId)
  } catch (error) {
    // If journaling fails, remove the projection BEFORE allowing the file write.
    // Failure to safely invalidate it aborts the write instead of hiding changes.
    discardThreadIndex(dir)
    console.warn('[thread-index] Invalidated failed cache before source write', error)
  }
}

async function flushThreadIndex(projectId: string): Promise<void> {
  const dir = projectDir(projectId)
  if (!existsSync(join(dir, THREAD_INDEX_FILE))) return
  activeIndexDirs.add(dir)
  try {
    const index = openThreadIndex(dir)
    if (index.ready) await index.repair((id) => readThreadMetaOnly(projectId, id, {}, true))
  } catch (error) {
    discardThreadIndex(dir)
    console.warn('[thread-index] Invalidated failed projection after source write', error)
  } finally {
    activeIndexDirs.delete(dir)
    trimThreadIndexes()
  }
}

async function withThreadIndex<T>(
  projectId: string,
  query: (index: SqliteThreadIndex) => T | Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  const dir = projectDir(projectId)
  if (!existsSync(dir)) return fallback()
  activeIndexDirs.add(dir)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const index = openThreadIndex(dir)
        if (!index.ready) {
          threadStoreEnvironment().perf.count('store:sqlite-rebuild')
          await index.replaceAll(await readProjectThreadMetas(projectId, {}, true))
        } else {
          await index.repair((id) => readThreadMetaOnly(projectId, id, {}, true))
        }
        return await query(index)
      } catch (error) {
        try {
          discardThreadIndex(dir)
        } catch {
          // Unsafe/unwritable cache artifacts stay untouched; reads use source files.
          console.warn('[thread-index] Using authoritative files; cache unavailable', error)
          return await fallback()
        }
        if (attempt === 1) {
          console.warn('[thread-index] Using authoritative files; cache rebuild failed', error)
        }
      }
    }
    return await fallback()
  } finally {
    activeIndexDirs.delete(dir)
    trimThreadIndexes()
  }
}

type CompletePrReferenceRead<T> = { kind: 'unscanned'; ids: string[] } | { kind: 'ready'; value: T }

/**
 * Metadata-only project opening stays lazy. Relationship queries, however, must
 * account for legacy transcripts even if their sidebar rows have never appeared.
 * Release the project queue before backfill: its commits join that same queue.
 * Recheck and query together so an intervening write cannot publish an unscanned
 * thread as a complete result. Persisted empty lists make the warm check cheap.
 */
async function withCompletePrReferences<T>(
  projectId: string,
  threadId: string | undefined,
  query: (index: SqliteThreadIndex) => T,
  fallback: (index: ThreadPrRelationshipIndex) => T,
): Promise<T> {
  const attempted = new Set<string>()
  for (;;) {
    const result = await runSerialized(queueKey(projectId), () =>
      withThreadIndex<CompletePrReferenceRead<T>>(
        projectId,
        (index) => {
          const ids = index.unscannedPrRefIds(threadId)
          return ids.length ? { kind: 'unscanned', ids } : { kind: 'ready', value: query(index) }
        },
        async () => {
          const threads = await readProjectThreadMetas(projectId, { includeArchived: false })
          const ids = threads
            .filter(
              (thread) =>
                thread.prRefs === undefined && (threadId === undefined || thread.id === threadId),
            )
            .map((thread) => thread.id)
          return ids.length
            ? { kind: 'unscanned', ids }
            : { kind: 'ready', value: fallback(new ThreadPrRelationshipIndex(threads)) }
        },
      ),
    )
    if (result.kind === 'ready') return result.value
    if (result.ids.some((id) => attempted.has(id))) {
      throw new Error('Could not complete PR reference backfill; source metadata is unavailable')
    }
    for (const id of result.ids) attempted.add(id)
    await backfillThreadPrRefs(projectId, result.ids, () => {})
  }
}

export function lookupPrThreadRelationships(
  projectId: string,
  pr: GithubPrRef,
): Promise<PrThreadRelationship[]> {
  return withCompletePrReferences(
    projectId,
    undefined,
    (index) => index.forPr(pr),
    (index) => index.forPr(pr),
  )
}

export function lookupCommitThreadProductions(
  projectId: string,
  repository: string,
  sha: string,
): Promise<ReturnType<ThreadPrRelationshipIndex['forCommit']>> {
  return runSerialized(queueKey(projectId), () =>
    withThreadIndex(
      projectId,
      (index) => index.forCommit(repository, sha),
      async () =>
        new ThreadPrRelationshipIndex(await readProjectThreadMetas(projectId)).forCommit(
          repository,
          sha,
        ),
    ),
  )
}

export function lookupThreadPrRelationships(
  projectId: string,
  threadId: string,
): Promise<ReturnType<ThreadPrRelationshipIndex['forThread']>> {
  return withCompletePrReferences(
    projectId,
    threadId,
    (index) => index.forThread(threadId),
    (index) => index.forThread(threadId),
  )
}

/**
 * Active threads that mention a URL or another thread. Complete only for threads
 * whose links were recorded (on append); legacy transcripts are not scanned.
 */
export function lookupThreadBacklinks(
  projectId: string,
  kind: ThreadLink['kind'],
  target: string,
): Promise<ThreadBacklink[]> {
  return runSerialized(queueKey(projectId), () =>
    withThreadIndex(
      projectId,
      (index) => index.backlinks(kind, target),
      async () => backlinksFor(await readProjectThreadMetas(projectId), kind, target),
    ),
  )
}

/** Direct source reader for diagnostics/rebuilds; deliberately bypasses the projection. */
export function loadProjectThreadMetasFromFiles(
  projectId: string,
  options: ThreadLoadOptions = {},
): Promise<Thread[]> {
  return runSerialized(queueKey(projectId), () => readProjectThreadMetas(projectId, options))
}

/** Release native cache handles on shutdown; the next read is a persistent-index restart. */
export function closeThreadStoreIndexes(): void {
  for (const index of threadIndexes.values()) index.close()
  threadIndexes.clear()
  activeIndexDirs.clear()
  metaCacheByDir.clear()
  metaCacheVersionsByDir.clear()
}

/** Native structured results only; source evidence survives later renderer metadata writes. */
export function recordThreadPrProduction(
  projectId: string,
  threadId: string,
  input: PrProduction,
): Promise<void> {
  const production = prProductionSchema.parse(input)
  return runStoreWrite(projectId, async () => {
    const path = join(threadDir(projectId, threadId), META_FILE)
    const meta = readMeta(threadDir(projectId, threadId))
    if (!meta) throw new Error('Cannot record PR production for a missing thread')
    const entries = meta.prProductions ?? []
    const previous = entries.find((item) => item.eventId === production.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(production))
      throw new Error('Conflicting PR production event')
    if (previous) return
    const { refs } = mergeGithubPrRefs(meta.prRefs ?? [], [production.pr])
    await atomicWriteFileAsync(
      path,
      JSON.stringify({ ...meta, prRefs: refs, prProductions: [...entries, production] }),
    )
    refreshCatalogLine(projectId, threadId)
  })
}

export function recordThreadCommitProduction(
  projectId: string,
  threadId: string,
  input: CommitProduction,
): Promise<void> {
  const production = commitProductionSchema.parse(input)
  return runStoreWrite(projectId, async () => {
    const path = join(threadDir(projectId, threadId), META_FILE)
    const meta = readMeta(threadDir(projectId, threadId))
    if (!meta) throw new Error('Cannot record commit production for a missing thread')
    const entries = meta.commitProductions ?? []
    const previous = entries.find((item) => item.eventId === production.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(production))
      throw new Error('Conflicting commit production event')
    if (previous) return
    await atomicWriteFileAsync(
      path,
      JSON.stringify({ ...meta, commitProductions: [...entries, production] }),
    )
  })
}

// --- Decoded per-project meta cache above the persistent projection --------
//
// SQLite removes per-thread file reads on a restart. These decoded snapshots
// additionally avoid JSON parsing on project switches; the
// per-project write queue is the invalidation hook: every entry point that
// writes `meta.json` or the spine goes through {@link runStoreWrite}, which
// drops the project's snapshots when the queued op settles. The version check
// additionally prevents any future unqueued writer from publishing an in-flight
// stale read. The index assumes one store-writing process. Out-of-band edits
// require removing the SQLite cache (including sidecars) with the app stopped.

interface CachedMetas {
  /** {@link metaCacheVersionsByDir} value the snapshot was read at. */
  version: number
  threads: Thread[]
}

/** How many projects keep warm snapshots before the least recent is dropped. */
const META_CACHE_DIR_LIMIT = 16
const metaCacheVersionsByDir = new Map<string, number>()
/** Keyed by project store dir (not id) so a changed `COPSE_WORKSPACE_DIR` misses. */
const metaCacheByDir = new Map<string, Map<boolean, CachedMetas>>()

/** Drop a project's snapshots; the bump also strips in-flight reads of their right to cache. */
function invalidateProjectMetaCache(projectId: string): void {
  const dir = projectDir(projectId)
  metaCacheVersionsByDir.set(dir, (metaCacheVersionsByDir.get(dir) ?? 0) + 1)
  metaCacheByDir.delete(dir)
}

/**
 * Run a store write on the project's queue, dropping the meta cache once the
 * op settles. Failed ops invalidate too: one that threw may still have
 * half-written the store, and the cache must never claim to describe it.
 */
function runStoreWrite<T>(projectId: string, op: () => T | Promise<T>): Promise<T> {
  return runSerialized(queueKey(projectId), async () => {
    try {
      return await op()
    } finally {
      invalidateProjectMetaCache(projectId)
      await flushThreadIndex(projectId)
    }
  })
}

/** Refresh LRU order and return the project's cached snapshots, if any. */
function cachedMetasFor(dir: string): Map<boolean, CachedMetas> | undefined {
  const cached = metaCacheByDir.get(dir)
  if (!cached) return undefined
  metaCacheByDir.delete(dir)
  metaCacheByDir.set(dir, cached)
  return cached
}

async function readProjectThreadMetasCached(
  projectId: string,
  options: ThreadLoadOptions,
): Promise<Thread[]> {
  const includeArchived = options.includeArchived !== false
  const dir = projectDir(projectId)
  const version = metaCacheVersionsByDir.get(dir) ?? 0
  const hit = cachedMetasFor(dir)?.get(includeArchived)
  if (hit && hit.version === version) {
    threadStoreEnvironment().perf.count('store:meta-cache-hit')
    return hit.threads
  }
  threadStoreEnvironment().perf.count('store:meta-cache-miss')
  const threads = await withThreadIndex(
    projectId,
    (index) => index.metas(includeArchived),
    () => readProjectThreadMetas(projectId, options),
  )
  // Cache only if nothing wrote the project while the read was in flight;
  // otherwise let the next read retry.
  if ((metaCacheVersionsByDir.get(dir) ?? 0) === version) {
    let entries = metaCacheByDir.get(dir)
    if (!entries) {
      if (metaCacheByDir.size >= META_CACHE_DIR_LIMIT) {
        const oldest: string | undefined = metaCacheByDir.keys().next().value
        if (oldest !== undefined) metaCacheByDir.delete(oldest)
      }
      entries = new Map()
      metaCacheByDir.set(dir, entries)
    }
    entries.set(includeArchived, { version, threads })
  }
  return threads
}

/** Logical bytes retained in this thread's store; never follow links outside it. */
export async function measureThreadStorage(
  projectId: string,
  threadId: string,
): Promise<{ bytes: number; truncated: boolean }> {
  const root = threadDir(projectId, threadId)
  const pending = [root]
  let bytes = 0
  let visited = 0
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined) break
    if (++visited > 100_000) return { bytes, truncated: true }
    try {
      const stat = await fsPromises.lstat(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isFile()) bytes += stat.size
      else if (stat.isDirectory()) {
        for (const name of await fsPromises.readdir(path)) pending.push(join(path, name))
      }
    } catch (error) {
      if (!(isRecord(error) && error['code'] === 'ENOENT')) throw error
    }
  }
  return { bytes, truncated: false }
}

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
  return runStoreWrite(projectId, () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    // Only patch an existing thread; the renderer writes the initial meta.json.
    if (current === null) return
    const nextMeta: ThreadMeta = { ...current, remoteAgentLink: { ...link }, id: threadId }
    writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify(nextMeta)}\n`)
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
 * Persist a terminal snapshot for an imported cloud-agent run.
 *
 * The stored link is re-read while holding the project's write queue. A
 * snapshot fetched for a thread that has since started another run therefore
 * cannot be appended to the wrong conversation. `message.id` is supplied by
 * the caller as a stable provider-run key, which also makes a retry reuse the
 * same completed answer rather than duplicating it.
 */
export function appendImportedRemoteAgentRunResult(
  projectId: string,
  threadId: string,
  input: {
    provider: RemoteAgentLink['provider']
    agentId: string
    runId: string
    message: Message
    canPersist?: () => boolean
  },
): Promise<Message | null> {
  return runStoreWrite(projectId, async () => {
    if (input.canPersist && !input.canPersist()) return null
    const current = await readThread(projectId, threadId)
    // The running-agent registry is in memory rather than on this queue. It
    // can change while readThread awaits the transcript, so test it again at
    // the last point before preparing an append.
    if (input.canPersist && !input.canPersist()) return null
    const currentLink = current?.remoteAgentLink
    if (
      !current ||
      current.status !== 'idle' ||
      current.queuePaused === true ||
      (current.pendingMessages?.length ?? 0) > 0 ||
      !currentLink ||
      !isImportedCursorAgentThread(current, input.message.id) ||
      currentLink.provider !== input.provider ||
      currentLink.agentId !== input.agentId ||
      currentLink.runId !== input.runId
    ) {
      return null
    }

    const existing = current.messages.find((message) => message.id === input.message.id)
    if (existing) {
      // A crash can land the spine before its PR metadata, migrated provenance,
      // or catalog row. Reapply every derived write on retry instead of treating
      // the deterministic message id as a complete no-op.
      await mergePrRefsIntoMeta(projectId, threadId, existing)
      const dir = threadDir(projectId, threadId)
      const latestMeta = readMeta(dir)
      const latestLink = latestMeta?.remoteAgentLink
      if (
        !latestMeta ||
        !latestLink ||
        !isImportedCursorAgentThread(
          { ...current, remoteAgentLink: latestLink },
          input.message.id,
        ) ||
        latestLink.provider !== input.provider ||
        latestLink.agentId !== input.agentId ||
        latestLink.runId !== input.runId
      ) {
        return null
      }
      const updatedAt = Math.max(current.updatedAt, existing.createdAt)
      const nextMeta: ThreadMeta = {
        ...latestMeta,
        remoteAgentLink: { ...latestLink, imported: true },
        updatedAt: Math.max(latestMeta.updatedAt, updatedAt),
        id: threadId,
      }
      writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify(nextMeta)}\n`)
      upsertCatalogEntry(projectId, { ...current, ...nextMeta, messages: current.messages })
      return existing
    }

    const committed = await appendMessageUnqueued(
      projectId,
      threadId,
      input.message,
      input.canPersist,
    )
    if (!committed) return null

    // `appendMessageUnqueued` may have refreshed cached PR refs. Re-read the
    // metadata before recording completion so that write is preserved.
    const dir = threadDir(projectId, threadId)
    const latestMeta = readMeta(dir)
    const latestLink = latestMeta?.remoteAgentLink
    if (
      !latestMeta ||
      !latestLink ||
      !isImportedCursorAgentThread(
        {
          ...current,
          remoteAgentLink: latestLink,
        },
        input.message.id,
      ) ||
      latestLink.provider !== input.provider ||
      latestLink.agentId !== input.agentId ||
      latestLink.runId !== input.runId
    ) {
      return null
    }
    const nextMeta: ThreadMeta = {
      ...latestMeta,
      remoteAgentLink: { ...latestLink, imported: true },
      updatedAt: Math.max(latestMeta.updatedAt, input.message.createdAt),
      id: threadId,
    }
    writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify(nextMeta)}\n`)
    upsertCatalogEntry(projectId, {
      ...current,
      ...nextMeta,
      messages: [...current.messages, input.message],
    })
    return input.message
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
  return runStoreWrite(projectId, () => {
    if (refs.length === 0) return
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    const link = current?.remoteAgentLink
    if (!current || !link || link.prUrl) return
    const prUrl = pickPrUrlForRepo(refs, link.repo)
    if (!prUrl) return
    const merged: RemoteAgentLink = { ...link, prUrl }
    const nextMeta: ThreadMeta = { ...current, remoteAgentLink: merged, id: threadId }
    writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify(nextMeta)}\n`)
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
    const matches = [...loadOrRebuildAgentPrIndex(projectId).values()].filter(
      (entry) => remoteAgentPrIndexKey(entry.prUrl) === key,
    )
    return matches.length === 1 ? (matches[0] ?? null) : null
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

/** Every thread in a project, transcripts included. */
export function loadProjectThreads(
  projectId: string,
  options: ThreadLoadOptions = {},
): Promise<Thread[]> {
  return runSerialized(queueKey(projectId), () => readProjectThreads(projectId, options))
}

/**
 * Every thread in a project as metadata only — `messages: []` plus
 * `messagesLoaded`. The renderer's project open uses this and fetches each
 * transcript with {@link loadThreadMessages} when its thread is opened.
 */
export function loadProjectThreadMetas(
  projectId: string,
  options: ThreadLoadOptions = {},
): Promise<Thread[]> {
  return runSerialized(queueKey(projectId), () => readProjectThreadMetasCached(projectId, options))
}

export function saveProjectThread(projectId: string, thread: Thread): Promise<void> {
  return runStoreWrite(projectId, () => {
    writeThread(projectId, thread)
    upsertCatalogEntry(projectId, thread)
  })
}

export function saveProjectThreads(projectId: string, threads: Thread[]): Promise<void> {
  return runStoreWrite(projectId, () => {
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
        markIndexSourceWrite(join(dir, META_FILE))
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
  return runStoreWrite(projectId, () => {
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
async function appendMessageUnqueued(
  projectId: string,
  threadId: string,
  message: Message,
  canCommit?: () => boolean,
): Promise<boolean> {
  const dir = threadDir(projectId, threadId)
  await fsPromises.mkdir(dir, { recursive: true })
  const { line, files } = explodeMessage(message, sha256)
  const targets = files.map((file) => ({
    path: contentFilePathForWrite(dir, file.ref),
    contents: file.contents,
  }))
  // Keep each referenced-file write inside this queued operation. Sequential
  // awaits are deliberate: Promise.all rejects before its surviving siblings
  // settle, which could release the project queue while a failed batch still
  // has writes in flight.
  for (const target of targets) {
    await writeFileEnsuringDirAsync(target.path, target.contents)
  }
  // File bodies are unreachable until a spine line refers to them. Check the
  // in-memory run owner before beginning the visible commit.
  if (canCommit && !canCommit()) return false
  const raw = serializeSpineLine(line)
  const knownIds = await knownMessageIdsFor(dir)
  // `knownMessageIdsFor` can await a disk read. Recheck immediately before the
  // user-visible spine commit so a local dispatch accepted in that interval
  // keeps sole ownership of the thread.
  if (canCommit && !canCommit()) return false
  // Let a dispatch accepted in a microtask queued by the final check take
  // ownership before starting the append. The recheck below is immediately
  // followed by the durable write, which is this operation's linearization
  // point for imported results.
  if (canCommit) {
    await Promise.resolve()
    if (!canCommit()) return false
  }
  if (!knownIds.has(message.id)) {
    assertStorePath(join(dir, EVENTS_FILE))
    markIndexSourceWrite(join(dir, EVENTS_FILE))
    await fsPromises.appendFile(join(dir, EVENTS_FILE), `${raw}\n`, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    })
    // Do not teach the cache about an id until the append is durable enough
    // for Node to resolve it. A rejected append must take this path again.
    knownIds.add(message.id)
  } else {
    const entries = parseSpineEntries((await readOrNull(join(dir, EVENTS_FILE))) ?? '')
    // Replacing an existing spine line has one more await before its write.
    // Preserve a dispatch that became active while that file was read.
    if (canCommit && !canCommit()) return false
    if (canCommit) {
      await Promise.resolve()
      if (!canCommit()) return false
    }
    const existingIndex = entries.findIndex(
      (entry) => entry.line?.type === 'message' && entry.line.id === message.id,
    )
    if (existingIndex >= 0) entries[existingIndex] = { raw, line }
    else entries.push({ raw, line })
    await writeStoreFileAsync(join(dir, EVENTS_FILE), serializeSpineEntries(entries))
  }
  // The sidebar's PR chip is derived from links in message text, which a
  // metadata-only load never reads. Derive it only after the spine commit, so
  // a rejected imported result cannot leave stale cloud PR refs in metadata.
  await mergePrRefsIntoMeta(projectId, threadId, message)
  return true
}

export function appendMessage(
  projectId: string,
  threadId: string,
  message: Message,
): Promise<void> {
  return runStoreWrite(projectId, async () => {
    await appendMessageUnqueued(projectId, threadId, message)
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
  return runStoreWrite(projectId, async () => {
    const dir = threadDir(projectId, threadId)
    await fsPromises.mkdir(dir, { recursive: true })
    const targets = blobs.map((blob) => ({ ...blob, full: contentFilePathForWrite(dir, blob.ref) }))
    for (const blob of targets) {
      const full = blob.full
      try {
        await fsPromises.access(full)
      } catch {
        await writeFileEnsuringDirAsync(full, blob.contents)
      }
    }
    await appendJsonlLine(join(dir, EVENTS_FILE), serializeSpineLine(line))
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
      const path = isThreadBlob ? contentFilePath(dir, ref.ref) : null
      return { ref: ref.ref, text: path === null ? null : safeRead(path) }
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

/** Append one control-plane decision (and optional detail blob) to the thread spine. */
export function appendSpineDecision(
  projectId: string,
  threadId: string,
  line: SpineDecisionLine | SpinePermissionDecisionLine,
  detailContents?: string,
): Promise<void> {
  return runStoreWrite(projectId, async () => {
    const dir = threadDir(projectId, threadId)
    await fsPromises.mkdir(dir, { recursive: true })
    if (detailContents !== undefined && line.type === 'decision' && line.detail) {
      await writeFileEnsuringDirAsync(contentFilePathForWrite(dir, line.detail.ref), detailContents)
    }
    await appendJsonlLine(join(dir, EVENTS_FILE), serializeSpineLine(line))
  })
}

/** Append one compact machine-continuation audit record. */
export function appendMachineContinuation(
  projectId: string,
  threadId: string,
  line: SpineMachineContinuationLine,
): Promise<void> {
  return runStoreWrite(projectId, async () => {
    const dir = threadDir(projectId, threadId)
    await appendJsonlLine(join(dir, EVENTS_FILE), serializeSpineLine(line))
  })
}

/** Append the boundary of a server-side context compaction to the thread spine. */
export function appendContextCompaction(
  projectId: string,
  threadId: string,
  line: SpineContextCompactionLine,
): Promise<void> {
  return runStoreWrite(projectId, async () => {
    const dir = threadDir(projectId, threadId)
    await appendJsonlLine(join(dir, EVENTS_FILE), serializeSpineLine(line))
  })
}

/** Append a model-selection event and mirror its compact history into thread metadata. */
export function recordModelSelection(
  projectId: string,
  threadId: string,
  line: SpineModelSelectedLine,
): Promise<void> {
  return runStoreWrite(projectId, async () => {
    const dir = threadDir(projectId, threadId)
    await appendJsonlLine(join(dir, EVENTS_FILE), serializeSpineLine(line))

    const current = readMeta(dir)
    if (current === null) return
    const selection: ModelSelectionEvent = {
      id: line.id,
      recordedAt: line.recordedAt,
      by: line.by,
      ...(line.from !== undefined ? { from: line.from } : {}),
      to: line.to,
    }
    const modelSelections = [...(current.modelSelections ?? []), selection]
    const next: ThreadMeta = { ...current, model: line.to, modelSelections, id: threadId }
    writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify(next)}\n`)
    refreshCatalogLine(projectId, threadId)
  })
}

/** Append one stream-cut observability record (project-level eval source). */
export function appendStreamStat(projectId: string, line: unknown): Promise<void> {
  return runStoreWrite(projectId, () =>
    appendJsonlLine(streamStatsPath(projectId), JSON.stringify(line)),
  )
}

/** Append one reasoning-checkpoint decision (project-level eval source). */
export function appendReasoningCheckpoint(projectId: string, line: unknown): Promise<void> {
  return runStoreWrite(projectId, () =>
    appendJsonlLine(reasoningCheckpointsPath(projectId), JSON.stringify(line)),
  )
}

/** Patch a thread's mutable metadata in place and refresh its catalog line. */
export function updateMeta(
  projectId: string,
  threadId: string,
  patch: Partial<ThreadMeta>,
): Promise<void> {
  return runStoreWrite(projectId, () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    // updateMeta only patches an existing thread; `createThread` writes the
    // initial meta.json, so a missing base means there is nothing to patch.
    if (current === null) return
    const merged: ThreadMeta = {
      ...current,
      ...patch,
      id: threadId,
      ...(current.prProductions ? { prProductions: current.prProductions } : {}),
      ...(current.commitProductions ? { commitProductions: current.commitProductions } : {}),
      ...mergedLinksField(current, patch),
    }
    writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify(merged)}\n`)
    refreshCatalogLine(projectId, threadId)
  })
}

/** Patch metadata, failing if the renderer has not persisted the thread yet. */
export function updateMetaOrThrow(
  projectId: string,
  threadId: string,
  patch: Partial<ThreadMeta>,
): Promise<void> {
  return runStoreWrite(projectId, () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    if (current === null) throw new Error('Thread is not persisted yet; retry sending the message')
    const merged: ThreadMeta = {
      ...current,
      ...patch,
      id: threadId,
      ...(current.prProductions ? { prProductions: current.prProductions } : {}),
      ...(current.commitProductions ? { commitProductions: current.commitProductions } : {}),
      ...mergedLinksField(current, patch),
    }
    writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify(merged)}\n`)
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
  return runStoreWrite(projectId, () => {
    const dir = threadDir(projectId, threadId)
    const current = readMeta(dir)
    if (current === null || current.worktree === undefined) return false
    const { worktree: _removed, ...rest } = current
    writeStoreFileSync(join(dir, META_FILE), `${JSON.stringify({ ...rest, id: threadId })}\n`)
    refreshCatalogLine(projectId, threadId)
    return true
  })
}

export function deleteProjectThread(projectId: string, threadId: string): Promise<void> {
  return runStoreWrite(projectId, () => {
    const dir = threadDir(projectId, threadId)
    markIndexSourceWrite(join(dir, META_FILE))
    rmSync(dir, { recursive: true, force: true })
    invalidateKnownMessageIds(dir)
    // Same rebuild-on-read invariant as the other catalog writers: a stale
    // (pre-`prRefs`) index read directly would be written back as empty.
    const entries = ensureCatalogMap(projectId)
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

function historyEditTransactionPath(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), HISTORY_EDIT_TRANSACTION_FILE)
}

function historyEditUndoPath(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), HISTORY_EDIT_UNDO_FILE)
}

export interface ThreadHistoryStateSnapshot {
  thread: Thread
  agentHistory: LLMMessage[]
  hadAgentHistory: boolean
}

export interface ThreadHistoryUndoSnapshot extends ThreadHistoryStateSnapshot {
  resultingRevision: string
}

function parseThreadHistoryState(value: unknown): ThreadHistoryStateSnapshot | null {
  if (!isRecord(value) || typeof value['hadAgentHistory'] !== 'boolean') return null
  const thread = parseThreadValue(value['thread'])
  const agentHistory = value['agentHistory']
  if (
    thread === null ||
    !Array.isArray(agentHistory) ||
    !agentHistory.every(isAgentHistoryMessage)
  ) {
    return null
  }
  return { thread, agentHistory, hadAgentHistory: value['hadAgentHistory'] }
}

function parseHistoryEditTransaction(raw: string): ThreadHistoryStateSnapshot | null {
  try {
    const value = parseJsonUnknown(raw)
    if (!isRecord(value) || value['v'] !== HISTORY_EDIT_VERSION) return null
    return parseThreadHistoryState(value['rollback'])
  } catch {
    return null
  }
}

function parseHistoryEditUndo(raw: string): ThreadHistoryUndoSnapshot | null {
  try {
    const value = parseJsonUnknown(raw)
    if (
      !isRecord(value) ||
      value['v'] !== HISTORY_EDIT_VERSION ||
      typeof value['resultingRevision'] !== 'string'
    ) {
      return null
    }
    const state = parseThreadHistoryState(value['previous'])
    return state ? { ...state, resultingRevision: value['resultingRevision'] } : null
  } catch {
    return null
  }
}

function writeAgentHistorySnapshot(
  projectId: string,
  threadId: string,
  messages: LLMMessage[],
): void {
  const dir = threadDir(projectId, threadId)
  mkdirSync(dir, { recursive: true })
  const body = `${JSON.stringify({ v: AGENT_HISTORY_VERSION, messages: stripToolResultImages(messages) })}\n`
  atomicWriteFile(join(dir, AGENT_HISTORY_FILE), body)
}

function unlinkIfPresent(path: string): void {
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    // Best-effort cleanup; a later recovery/read retries stale sidecar cleanup.
  }
}

/** Threads whose staged history journal belongs to a mutation still in flight in this process. */
const activeHistoryMutations = new Set<string>()

function historyMutationKey(projectId: string, threadId: string): string {
  return `${projectId}/${threadId}`
}

/** Roll back an interrupted transcript/provider-history replacement before reads resume. */
function recoverPendingHistoryEdit(projectId: string, threadId: string, force = false): void {
  // A journal owned by a mutation still running in this process is live, not
  // stale: a read between its separate writes must not roll it back.
  if (!force && activeHistoryMutations.has(historyMutationKey(projectId, threadId))) return
  const path = historyEditTransactionPath(projectId, threadId)
  const raw = safeRead(path)
  if (raw === null) return
  const rollback = parseHistoryEditTransaction(raw)
  if (rollback === null || rollback.thread.id !== threadId) {
    throw new Error(`Thread history recovery data for "${threadId}" is invalid`)
  }
  writeThread(projectId, rollback.thread)
  upsertCatalogEntry(projectId, rollback.thread)
  if (rollback.hadAgentHistory) {
    writeAgentHistorySnapshot(projectId, threadId, rollback.agentHistory)
  } else {
    unlinkIfPresent(agentHistoryPath(projectId, threadId))
  }
  unlinkIfPresent(agentEpochPath(projectId, threadId))
  unlinkSync(path)
}

/** Durably record the state restored if the following history mutation is interrupted. */
export function stageThreadHistoryMutation(
  projectId: string,
  threadId: string,
  rollback: ThreadHistoryStateSnapshot,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const key = historyMutationKey(projectId, threadId)
    if (activeHistoryMutations.has(key))
      throw new Error('A history mutation is already in progress')
    recoverPendingHistoryEdit(projectId, threadId)
    if (rollback.thread.id !== threadId) throw new Error('History rollback thread id mismatch')
    atomicWriteFile(
      historyEditTransactionPath(projectId, threadId),
      `${JSON.stringify({ v: HISTORY_EDIT_VERSION, rollback })}\n`,
      0o600,
    )
    activeHistoryMutations.add(key)
  })
}

/** Save the one-step Undo snapshot, then make the staged replacement authoritative. */
export function commitThreadHistoryMutation(
  projectId: string,
  threadId: string,
  resultingRevision: string,
  previous: ThreadHistoryStateSnapshot,
): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const transaction = historyEditTransactionPath(projectId, threadId)
    if (!existsSync(transaction)) throw new Error('History mutation transaction is missing')
    atomicWriteFile(
      historyEditUndoPath(projectId, threadId),
      `${JSON.stringify({ v: HISTORY_EDIT_VERSION, resultingRevision, previous })}\n`,
      0o600,
    )
    // The rollback journal must be gone before success becomes observable.
    unlinkSync(transaction)
    activeHistoryMutations.delete(historyMutationKey(projectId, threadId))
  })
}

export function loadThreadHistoryUndo(
  projectId: string,
  threadId: string,
): Promise<ThreadHistoryUndoSnapshot | null> {
  return runSerialized(queueKey(projectId), () => {
    recoverPendingHistoryEdit(projectId, threadId)
    const raw = safeRead(historyEditUndoPath(projectId, threadId))
    if (raw === null) return null
    const parsed = parseHistoryEditUndo(raw)
    if (parsed === null || parsed.thread.id !== threadId) return null
    return parsed
  })
}

export function clearThreadHistoryUndo(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    unlinkIfPresent(historyEditUndoPath(projectId, threadId))
  })
}

/** Finish a successful Undo: its restored state is live, so no rollback remains pending. */
export function finishThreadHistoryUndo(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    // A surviving journal would roll this successful Undo back on the next read.
    unlinkSync(historyEditTransactionPath(projectId, threadId))
    unlinkIfPresent(historyEditUndoPath(projectId, threadId))
    activeHistoryMutations.delete(historyMutationKey(projectId, threadId))
  })
}

/** Explicit recovery for a failed in-process mutation; reads also call this automatically. */
export function recoverThreadHistoryMutation(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    try {
      recoverPendingHistoryEdit(projectId, threadId, true)
    } finally {
      activeHistoryMutations.delete(historyMutationKey(projectId, threadId))
    }
  })
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

/**
 * A thread's own directory in the chat store.
 *
 * Exposed for sidecar writers that are not part of the thread model and must
 * not become part of it — today the opt-in ACP wire trace
 * (`acp-wire-trace.ts`), which appends `acp-debug.jsonl` beside `events.jsonl`.
 * A root-level file like that is safe by construction: {@link writeThread}
 * regenerates only the spine and prunes only {@link CONTENT_DIRS}, and
 * {@link readThread} reads only `meta.json` and the spine, so a full save keeps
 * it and a load ignores it.
 */
export function threadDirectoryPath(projectId: string, threadId: string): string {
  return threadDir(projectId, threadId)
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
    const dirents = await fsPromises.readdir(dir, { withFileTypes: true, recursive: true })
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
      assertStorePath(full)
      const handle = await fsPromises.open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stats = await handle.stat()
        total += stats.size
        if (total > MAX_THREAD_DIRECTORY_BYTES) {
          throw new Error('This thread is too large to export as an archive')
        }
        files.push({ path, data: await handle.readFile(), modifiedAt: stats.mtime })
      } finally {
        await handle.close()
      }
    }
    return files
  })
}

/** Load provider history for a thread. Missing/corrupt/future-version → `[]`. */
export function loadAgentHistory(projectId: string, threadId: string): Promise<LLMMessage[]> {
  return runSerialized(queueKey(projectId), () => {
    recoverPendingHistoryEdit(projectId, threadId)
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
    // Images a tool produced (video frames) are regenerable from the paths its
    // text result names, so they never reach the sidecar — see
    // `stripToolResultImages` for why that matters to file size.
    writeAgentHistorySnapshot(projectId, threadId, messages)
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

/** Remove only the machine-continuation epoch after transcript reconstruction. */
export function clearAgentTurnEpoch(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const path = agentEpochPath(projectId, threadId)
    if (!existsSync(path)) return
    try {
      unlinkSync(path)
    } catch {
      // Best-effort: a missing file is the desired end state.
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
            // PR keys are `owner/repo#number`: a bare `2262`, a `#2262`, and a
            // full `owner/repo#2262` all reach the same key, with a numeric term
            // pinned to the whole number so `2262` does not also find #22620.
            const keys = e.prRefs.map(githubPrKey)
            return terms.every(
              (term) =>
                haystack.includes(term) || keys.some((key) => githubPrKeyMatchesTerm(key, term)),
            )
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
 *
 * Each row carries a few recent titles from the store catalog so the sidebar can
 * show what would be recovered instead of only a bare count.
 */
export function listOrphanProjectStores(knownProjectIds: string[]): Promise<OrphanProjectStore[]> {
  const known = new Set(knownProjectIds)
  return runSerialized('thread-store:orphans', () => {
    const orphans: OrphanProjectStore[] = []
    for (const id of listProjectStoreIds()) {
      if (known.has(id)) continue
      const threadCount = countThreadDirs(id)
      if (threadCount === 0) continue
      const entries = [...ensureCatalogMap(id).values()].sort((a, b) => b.updatedAt - a.updatedAt)
      const sampleTitles = entries
        .map((entry) => entry.title.trim())
        .filter((title) => title.length > 0)
        .slice(0, 3)
      orphans.push({
        id,
        threadCount,
        sampleTitles,
        updatedAt: entries[0]?.updatedAt ?? null,
      })
    }
    orphans.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))
    return orphans
  })
}

/**
 * Load every transcript across configured projects for whole-history callers.
 *
 * Must go through {@link loadProjectThreads} (the per-project write queue), not
 * {@link readProjectThreads} directly: once reads are async and yield to the
 * event loop, an unqueued load can interleave with `saveProjectThread` and
 * observe a torn thread directory.
 */
export async function loadAllProjectThreads(): Promise<Thread[]> {
  const threads: Thread[] = []
  for (const projectId of configuredProjectIds()) {
    threads.push(...(await loadProjectThreads(projectId)))
  }
  return threads
}

/**
 * Load every thread's metadata across configured projects, without folding any
 * transcript bodies. Usage summaries consume only `thread.usage`, so paying for
 * messages, tool results, and blobs here would make opening Usage scale with
 * unrelated conversation history and let one corrupt body hide valid totals.
 */
export async function loadAllProjectThreadMetas(): Promise<Thread[]> {
  const threads: Thread[] = []
  for (const projectId of configuredProjectIds()) {
    threads.push(...(await loadProjectThreadMetas(projectId)))
  }
  return threads
}

function configuredProjectIds(): string[] {
  return threadStoreEnvironment().listProjectIds()
}
