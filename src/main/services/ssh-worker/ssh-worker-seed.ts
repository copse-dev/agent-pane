import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { SshThreadRefused } from '@shared/ssh-thread-refused.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { z } from 'zod'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import {
  isRendererWritableSettingKey,
  isSecretSettingKey,
  securitySettingsSchema,
} from '../storage/settings-writable.ts'
import { parseThreadMetaValue } from '@copse/thread-store/thread-boundary.ts'
import { parseSpineLine } from '@copse/thread-store/spine-schema.ts'
import { adoptThreadFiles, threadDirectoryPath } from '../thread-store.ts'
import {
  packArchive,
  packageFromArchive,
  readArchive,
  walk,
  type ArchiveEntry,
} from './ssh-worker-package.ts'
import {
  packThreadArgv,
  remoteThreadDir,
  replaceHistoryArgv,
  THREAD_HELD_EXIT,
  threadStateArgv,
  userDataDir,
  writeFilesArgv,
  type RemoteNode,
} from './ssh-worker-remote.ts'

/**
 * Give the worker on an SSH host what a turn of an SSH thread reads there,
 * and keep the app's copy of the thread
 * (`docs/plans/harness-worker-roadmap.md`, R3 step 3).
 *
 * The worker runs on the host, so to it the SSH project is a project of its
 * own: the same id, rooted at the remote path, with no SSH host, so its tools
 * run there directly. It gets the settings a turn reads and nothing secret:
 * only settings the renderer may write, which by construction hold no keys,
 * less those that name other machines or carry an agent's environment, and
 * none of the app's other projects.
 *
 * The thread lives on the host while a turn runs there, and the laptop keeps a
 * mirror: before each turn the laptop's copy goes to the host (after taking
 * the host's first when the host has more, from a turn it ran by itself), and
 * once the turn ends the host's comes back. So a turn the app ran while the
 * host could not be reached is never lost to the next one there.
 */

export interface SeededProject {
  id: string
  name: string
  /** The project's directory on the host. */
  path: string
}

/**
 * Settings that stay on this computer: other machines and the agents it runs,
 * whose environment can hold a token.
 */
const KEPT_HERE = new Set([
  'localServerUrl',
  'skillPluginPaths',
  'trustedPackageRegistries',
  'sshWorkspaceEnabled',
  'sshWorkspaceHosts',
  'trustedSshHosts',
  'productionTargets',
  'registeredAcpAgents',
])

/** The user's Security choices, which bind a turn there as here. */
const SECURITY_KEYS = securitySettingsSchema.shape

/** The worker's `config.json` and `settings.json`, built from the app's. */
export function workerStores(
  settings: Record<string, unknown>,
  project: SeededProject,
): { config: Record<string, unknown>; settings: Record<string, unknown> } {
  const shared: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    const shareable = isRendererWritableSettingKey(key) || Object.hasOwn(SECURITY_KEYS, key)
    if (!shareable || isSecretSettingKey(key)) continue
    if (key.startsWith('mcpOAuth.') || KEPT_HERE.has(key)) continue
    shared[key] = value
  }
  return {
    config: {
      projects: [{ id: project.id, name: project.name, path: project.path }],
      activeProjectId: project.id,
      workspaceRoot: project.path,
    },
    settings: shared,
  }
}

const HISTORY_FILES = new Set(['meta.json', 'events.jsonl', 'agent-history.json'])
const HISTORY_DIRS = new Set(['messages', 'blobs', 'subagents', 'plans'])

/** Files a thread's history is made of; leases, indexes and records stay behind. */
export function isThreadHistoryPath(path: string): boolean {
  const [top = '', ...rest] = path.split('/')
  return rest.length === 0 ? HISTORY_FILES.has(top) || HISTORY_DIRS.has(top) : HISTORY_DIRS.has(top)
}

/** A file of a thread's history: a top-level name for a directory is no file. */
function isThreadHistoryFile(path: string): boolean {
  const [top = '', ...rest] = path.split('/')
  return rest.length === 0 ? HISTORY_FILES.has(top) : HISTORY_DIRS.has(top)
}

/** The most a thread's copy may weigh on its way back: past it the copy fails. */
const MIRROR_MAX_BYTES = 256 * 1024 * 1024

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-3).join('\n') || 'no output'
}

/** The size of the app's `events.jsonl` (-1 for none) and the SHA-256 of its first `prefix` bytes. */
async function localEvents(
  dir: string,
  prefix: number,
): Promise<{ size: number; prefixHash: string }> {
  let file
  try {
    file = await open(join(dir, 'events.jsonl'))
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return { size: -1, prefixHash: '' }
    throw error
  }
  try {
    const { size } = await file.stat()
    const head = Buffer.alloc(Math.min(prefix, size))
    await file.read(head, 0, head.length, 0)
    return { size, prefixHash: sha256(head) }
  } finally {
    await file.close()
  }
}

/** A prefix that takes in the whole of `events.jsonl`. */
const WHOLE = Number.MAX_SAFE_INTEGER

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Beside the app's copy of a thread, not part of its history: the hash of its
 * `events.jsonl` when it was last the same here and on the host. A copy whose
 * events changed since then moved (a turn, a rewind, an edit).
 */
const SYNC_MARK_FILE = 'ssh-host-sync.json'

const syncMarkSchema = z.object({
  threadId: z.string(),
  eventsHash: z.string(),
  // Left out by marks written before it was kept.
  eventsSize: z.number().int().nonnegative().optional(),
  // Prompts this computer added since, which the host refused as it ran a turn.
  refused: z.array(z.string().max(256)).max(1_000).optional(),
})

/**
 * The events both copies last shared: their hash, their length when known,
 * and the prompts added here since that the host refused.
 */
interface SyncMark {
  hash: string
  size: number | undefined
  refused: string[]
}

async function readSyncMark(dir: string, threadId: string): Promise<SyncMark | null> {
  const text = await readFile(join(dir, SYNC_MARK_FILE), 'utf8').catch(() => null)
  const mark = text === null ? null : safeJsonParse(text, decodeWithSchema(syncMarkSchema))
  // A copy of the thread (a fork) is not the thread the mark was made for.
  return mark?.threadId === threadId
    ? { hash: mark.eventsHash, size: mark.eventsSize, refused: mark.refused ?? [] }
    : null
}

async function writeMark(dir: string, threadId: string, mark: SyncMark): Promise<void> {
  const file = join(dir, SYNC_MARK_FILE)
  await writeFile(
    `${file}.tmp`,
    JSON.stringify({
      threadId,
      eventsHash: mark.hash,
      eventsSize: mark.size,
      ...(mark.refused.length > 0 ? { refused: mark.refused } : {}),
    }),
  )
  await rename(`${file}.tmp`, file)
}

async function writeSyncMark(dir: string, threadId: string, events: Buffer): Promise<void> {
  await writeMark(dir, threadId, { hash: sha256(events), size: events.length, refused: [] })
}

/**
 * How much of these events is what both copies shared at the mark, or null
 * when they do not begin with it. A mark from before lengths were kept is
 * matched at each line's end.
 */
function sharedLength(events: Buffer, mark: SyncMark): number | null {
  if (mark.size !== undefined)
    return events.length >= mark.size && sha256(events.subarray(0, mark.size)) === mark.hash
      ? mark.size
      : null
  const hash = createHash('sha256')
  if (hash.copy().digest('hex') === mark.hash) return 0
  let start = 0
  for (let end = events.indexOf(10); end >= 0; end = events.indexOf(10, end + 1)) {
    hash.update(events.subarray(start, end + 1))
    start = end + 1
    if (hash.copy().digest('hex') === mark.hash) return start
  }
  return null
}

/** The prompts these events hold past `from`. */
function promptIds(events: Buffer, from: number): string[] {
  return events
    .subarray(from)
    .toString('utf8')
    .split('\n')
    .map((line) => parseSpineLine(line))
    .flatMap((line) => (line?.type === 'message' && line.role === 'user' ? [line.id] : []))
}

/** {@link markRefused}, whose failure must not stop the refusal it goes with. */
async function markRefusedOrLog(dir: string, threadId: string): Promise<void> {
  await markRefused(dir, threadId).catch((error: unknown) => {
    console.warn(`[ssh-worker] could not keep ${threadId}'s refused prompt: ${String(error)}`)
  })
}

/**
 * The host would not take the thread while its turn ran there: the prompts
 * added here since the sync are kept as refused, so once that turn ends they
 * go after it rather than forking the thread.
 */
async function markRefused(dir: string, threadId: string): Promise<void> {
  const mark = await readSyncMark(dir, threadId)
  const events = await readFile(join(dir, 'events.jsonl')).catch(() => null)
  if (mark === null || events === null) return
  const shared = sharedLength(events, mark)
  if (shared === null) return
  // The prompt being sent now, which the store wrote before asking for the
  // turn; an earlier one may have run here.
  const refusedNow = promptIds(events, shared).at(-1)
  if (refusedNow === undefined) return
  const refused = [...new Set([...mark.refused, refusedNow])]
  await writeMark(dir, threadId, { hash: mark.hash, size: shared, refused })
}

/**
 * What this computer added to a thread's events since the sync, when that is
 * only prompts no turn ran: a prompt refused while the host ran a turn of its
 * own, kept here. Null when the copy here changed in any other way.
 */
function unrunPrompts(events: Buffer, mark: SyncMark, shared: number): Buffer | null {
  const tail = events.subarray(shared)
  const lines = tail
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseSpineLine(line))
  const prompts = lines.flatMap((line) =>
    line?.type === 'message' && line.role === 'user' ? [line.id] : [],
  )
  // The prompt being sent now, and those the host refused; a prompt that is
  // neither may have run here, cut off before any answer, so it is a fork.
  const last = prompts.at(-1)
  // A mark from before refusals were kept cannot tell: a thread stuck as
  // forked before then takes every prompt it holds.
  const unrun = (id: string): boolean =>
    id === last || mark.refused.includes(id) || mark.size === undefined
  for (const line of lines) {
    const prompt = line?.type === 'message' && line.role === 'user' && unrun(line.id)
    if (!prompt && line?.type !== 'model_selected') return null
  }
  return prompts.length > 0 ? tail : null
}

/** The events with their last line ended, so more can follow. */
function withLineEnd(events: Buffer): Buffer {
  return events.length === 0 || events.at(-1) === 10
    ? events
    : Buffer.concat([events, Buffer.from('\n')])
}

/** A turn runs the thread on the host. */
export const SSH_THREAD_BUSY =
  'This thread is still running on its SSH host. Stop it or wait for it to finish.'

const SSH_THREAD_FORKED =
  'This thread went on both here and on its SSH host. Fork it to keep working from this copy.'

const threadStateSchema = z.object({
  size: z.number().int().min(-1),
  prefixHash: z.string(),
  held: z.boolean(),
})

/** What the host has of a thread whose first `prefix` event bytes the app compares. */
export async function hostThreadState(
  connection: SshConnection,
  node: RemoteNode,
  projectId: string,
  threadId: string,
  prefix = 0,
): Promise<z.infer<typeof threadStateSchema>> {
  const read = await connection.execArgv(
    threadStateArgv(node, remoteThreadDir(node, projectId, threadId), prefix),
    { timeoutMs: 60_000 },
  )
  const state = safeJsonParse(read.stdout.trim(), decodeWithSchema(threadStateSchema))
  if (read.code !== 0 || state === null)
    throw new Error(`could not read the thread on the host: ${lastLines(read.stderr)}`)
  return state
}

/** The laptop's meta, as far as the seed and the mirror compare it. */
async function readLocalMeta(dir: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(join(dir, 'meta.json'), 'utf8').catch(() => null)
  if (text === null) return null
  const meta = safeJsonParse(text)
  return isRecord(meta) ? meta : null
}

/** What the host was given of the thread, for the copy back. */
export interface SeededThread {
  /** The thread's title then: one that changed here since is the user's rename. */
  title?: string
}

/**
 * Write the worker's stores for `project`, and give it this computer's copy of
 * the thread, taking the host's first when the host's has more. Throws
 * `SshThreadRefused` while a turn runs the thread there, or when the two
 * copies went apart.
 */
export async function seedSshWorker(
  connection: SshConnection,
  node: RemoteNode,
  input: { settings: Record<string, unknown>; project: SeededProject; threadId: string },
): Promise<SeededThread> {
  const stores = workerStores(input.settings, input.project)
  const storeFiles = packageFromArchive(
    packArchive(
      Object.entries(stores).map(([name, value]) => ({
        path: `${name}.json`,
        mode: 0o600,
        data: Buffer.from(JSON.stringify(value)),
      })),
    ),
  )
  const wrote = await connection.execArgv(
    writeFilesArgv(node, userDataDir(node), storeFiles.hash),
    {
      stdin: storeFiles.archive.toString('base64'),
      timeoutMs: 60_000,
    },
  )
  if (wrote.code !== 0)
    throw new Error(`could not give the worker its settings: ${lastLines(wrote.stderr)}`)

  const { id: projectId } = input.project
  const { threadId } = input
  const remote = remoteThreadDir(node, projectId, threadId)
  const local = threadDirectoryPath(projectId, threadId)
  const there = await hostThreadState(connection, node, projectId, threadId, WHOLE)
  if (there.held) {
    await markRefusedOrLog(local, threadId)
    throw new SshThreadRefused(SSH_THREAD_BUSY)
  }
  if (there.size >= 0) {
    const here = await localEvents(local, WHOLE)
    const synced = await readSyncMark(local, threadId)
    if (there.prefixHash !== here.prefixHash) {
      if (synced === null) {
        // No sync yet to tell which side moved: the shorter copy must be
        // where the longer one began.
        const shared = Math.min(there.size, Math.max(here.size, 0))
        const head = await hostThreadState(connection, node, projectId, threadId, shared)
        if (here.size >= 0 && head.prefixHash !== (await localEvents(local, shared)).prefixHash)
          throw new SshThreadRefused(SSH_THREAD_FORKED)
        if (there.size > here.size) await pullThreadMirror(connection, node, projectId, threadId)
      } else {
        // Only the side that moved since the last sync wins; both is a fork.
        const hostMoved = there.prefixHash !== synced.hash
        const laptopMoved = here.prefixHash !== synced.hash
        // Prompts here that no turn ran go after the host's turn rather than
        // forking the thread; anything else here is a fork.
        if (hostMoved && laptopMoved)
          await pullThreadMirror(connection, node, projectId, threadId, {}, synced)
        else if (hostMoved) await pullThreadMirror(connection, node, projectId, threadId)
      }
    }
  }
  const seeded = await readLocalMeta(local)

  const entries: ArchiveEntry[] = []
  try {
    await walk(local, local, entries, isThreadHistoryPath)
  } catch (error) {
    // A thread with no history here yet starts empty there.
    if (isRecord(error) && error['code'] === 'ENOENT') return {}
    throw error
  }
  const history = packageFromArchive(packArchive(entries))
  const copied = await connection.execArgv(replaceHistoryArgv(node, remote, history.hash), {
    stdin: history.archive.toString('base64'),
    timeoutMs: 600_000,
  })
  if (copied.code === THREAD_HELD_EXIT) {
    await markRefusedOrLog(local, threadId)
    throw new SshThreadRefused(SSH_THREAD_BUSY)
  }
  if (copied.code !== 0)
    throw new Error(`could not give the worker the thread: ${lastLines(copied.stderr)}`)
  // The events as they went, not as they may be by now.
  const pushed = entries.find((entry) => entry.path === 'events.jsonl')
  if (pushed !== undefined) await writeSyncMark(local, threadId, pushed.data)
  return typeof seeded?.['title'] === 'string' ? { title: seeded['title'] } : {}
}

/**
 * Bring the app's copy of a thread up to the host's, through the thread
 * store, so nothing here writes the thread meanwhile and its caches see the
 * copy. Resolves whether the host had the thread.
 *
 * With `keepPrompts`, both copies moved since that sync: the host's is taken
 * only if it grew from the synced events, and the prompts added here go after
 * it. Anything else is refused as a fork.
 */
export async function pullThreadMirror(
  connection: SshConnection,
  node: RemoteNode,
  projectId: string,
  threadId: string,
  seeded: SeededThread = {},
  keepPrompts?: SyncMark,
): Promise<boolean> {
  const packed = await connection.execArgv(
    packThreadArgv(node, remoteThreadDir(node, projectId, threadId)),
    { timeoutMs: 600_000, maxBytes: MIRROR_MAX_BYTES },
  )
  if (packed.code !== 0)
    throw new Error(`could not read the thread on the host: ${lastLines(packed.stderr)}`)
  const out = packed.stdout.trim()
  if (out === '') return false
  const cut = out.lastIndexOf('\nend ')
  const text = cut < 0 ? '' : out.slice(0, cut)
  if (cut < 0 || out.slice(cut + 5) !== String(text.length))
    throw new Error('the thread on the host is too large to copy back, or its copy was cut short')
  // Throws on a copy cut short or naming a path outside the thread.
  const entries = readArchive(Buffer.from(text, 'base64'))
  const stray = entries.find((entry) => !isThreadHistoryFile(entry.path))
  if (stray !== undefined)
    throw new Error(`the host's copy of the thread holds a file it should not: ${stray.path}`)
  const hostEvents = entries.find((entry) => entry.path === 'events.jsonl')
  await adoptThreadFiles(projectId, threadId, async (dir) => {
    let prompts: Buffer | null = null
    if (keepPrompts !== undefined) {
      const mine = await readFile(join(dir, 'events.jsonl')).catch(() => null)
      const shared = mine === null ? null : sharedLength(mine, keepPrompts)
      const grew =
        hostEvents !== undefined &&
        shared !== null &&
        sharedLength(hostEvents.data, { ...keepPrompts, size: shared }) !== null
      prompts = grew && mine !== null ? unrunPrompts(mine, keepPrompts, shared) : null
      if (prompts === null) throw new SshThreadRefused(SSH_THREAD_FORKED)
    }
    const here = await readLocalMeta(dir)
    for (const entry of entries) {
      const data =
        entry.path === 'meta.json'
          ? mergedMeta(entry.data, here, seeded, threadId)
          : entry.path === 'events.jsonl' && prompts !== null
            ? Buffer.concat([withLineEnd(entry.data), prompts])
            : entry.data
      const file = join(dir, ...entry.path.split('/'))
      await mkdir(dirname(file), { recursive: true })
      const part = `${file}.mirror-${String(process.pid)}`
      await writeFile(part, data)
      await rename(part, file)
    }
    // The host's events are what both copies now share; prompts kept here
    // are this copy's to send.
    if (hostEvents !== undefined)
      await writeMark(dir, threadId, {
        hash: sha256(hostEvents.data),
        size: hostEvents.data.length,
        // Until they reach the host, the kept prompts are still refused ones.
        refused: prompts === null ? [] : (keepPrompts?.refused ?? []),
      })
  })
  return true
}

/**
 * Fields of a thread's meta that this computer owns: what the user does here
 * while the turn runs (a queued prompt, a draft, links), and what names this
 * computer's things (its worktree, its agents, an imported session). The
 * host's copy never replaces them.
 */
const LAPTOP_META_FIELDS = new Set([
  'pendingMessages',
  'queuePaused',
  'draftPrompt',
  'unreadAt',
  'links',
  'sideChat',
  'followUpOf',
  'worktree',
  'worktreeChoice',
  'deferredWorktree',
  'remoteAgentLink',
  'cursorAgentIds',
  'importedSession',
  'executionMode',
  'profileId',
  'automation',
  'proposedBy',
  'archives',
  'archivedAt',
  // The models a turn may call: the app allows the host only these.
  'model',
  'reasoning',
  'modelSelections',
])

/** Counts of what the thread used, which the host's copy may only raise. */
const LAPTOP_COUNT_FIELDS = ['continuationUsed', 'crossThreadPromptsUsed']
/** The same, counted per scope. */
const LAPTOP_COUNT_RECORDS = ['crossThreadPromptCounts']

/** The higher of two counts, where only a finite number above this computer's (0 if none) counts. */
function raisedCount(mine: unknown, theirs: unknown): number {
  const base = typeof mine === 'number' && Number.isFinite(mine) ? mine : 0
  return typeof theirs === 'number' && Number.isFinite(theirs) && theirs > base ? theirs : base
}

/** Each scope's count raised as {@link raisedCount} raises one; scopes only this computer has stay. */
function raisedCounts(mine: unknown, theirs: unknown): Record<string, number> {
  const here = isRecord(mine) ? mine : {}
  const there = isRecord(theirs) ? theirs : {}
  return Object.fromEntries(
    [...new Set([...Object.keys(here), ...Object.keys(there)])].map((scope) => [
      scope,
      raisedCount(here[scope], there[scope]),
    ]),
  )
}

/** The host's meta with this computer's own fields kept. */
function mergedMeta(
  hostData: Buffer,
  here: Record<string, unknown> | null,
  seeded: SeededThread,
  threadId: string,
): Buffer {
  const host = safeJsonParse(hostData.toString('utf8'))
  if (!isRecord(host)) throw new Error("the host's copy of the thread has a damaged meta.json")
  const merged = Object.fromEntries(
    Object.entries(host).filter(([field]) => !LAPTOP_META_FIELDS.has(field)),
  )
  if (here !== null) {
    for (const field of LAPTOP_META_FIELDS)
      if (Object.hasOwn(here, field)) merged[field] = here[field]
    for (const field of LAPTOP_COUNT_FIELDS)
      if (Object.hasOwn(here, field) || Object.hasOwn(merged, field))
        merged[field] = raisedCount(here[field], merged[field])
    for (const field of LAPTOP_COUNT_RECORDS)
      if (Object.hasOwn(here, field) || Object.hasOwn(merged, field))
        merged[field] = raisedCounts(here[field], merged[field])
    if (here['title'] !== seeded.title && typeof here['title'] === 'string')
      merged['title'] = here['title']
  }
  // The thread is the one this copy is for, whatever the host's file says.
  merged['id'] = threadId
  // A meta the store would not read would drop the thread from its list.
  if (parseThreadMetaValue(merged) === null)
    throw new Error("the host's copy of the thread has a meta.json this app cannot read")
  return Buffer.from(JSON.stringify(merged))
}
