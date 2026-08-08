/**
 * Long-lived seatbelt-wrapped fs worker.
 *
 * The renderer's `fs:*` IPC (file-tree listings, file previews, content reloads) used to spawn a
 * fresh ASRT-wrapped Electron-as-Node process per call — cheap kernel enforcement, but a heavy
 * process spawn + seatbelt-wrap on every directory expansion (seconds on large repos, see #513).
 * This keeps a single worker alive per workspace root and pipes newline-delimited JSON requests to
 * it, so the spawn cost is paid once. Requests are correlated by an incrementing `id`.
 *
 * Transport failures (spawn failure, worker crash, timeout) reject with {@link SandboxFsServerUnavailable}
 * so the caller can fall back to a one-shot spawn; a worker that returns `{ ok: false }` is a normal
 * filesystem error and resolves through the same channel.
 */
import type { ChildProcess } from 'node:child_process'
import { getWorkspaceRoot } from '../services/workspace.ts'
import { terminateProcessTree } from '../services/exec/subprocess-kill.ts'
import { fsServerSandboxOverlay } from './config.ts'
import { afterSandboxedCommand, spawnInProjectSandbox } from './spawn.ts'
import { sandboxFsWorkerPath, SANDBOX_FS_WORKER_STDOUT_MAX_BYTES } from './sandbox-fs-client.ts'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

export const SANDBOX_FS_SERVER_ENV = 'COPSE_SANDBOX_FS_SERVER'

/** A wedged worker that never answers should not stall the UI forever; tear it down and fall back. */
const REQUEST_TIMEOUT_MS = 15_000
/** Cap accumulated unframed output so a runaway worker can't grow the buffer without bound. */
const MAX_BUFFER_BYTES = SANDBOX_FS_WORKER_STDOUT_MAX_BYTES * 4

export type SandboxFsResponse = { ok: boolean; error?: string } & Record<string, unknown>

export class SandboxFsServerUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxFsServerUnavailable'
  }
}

interface Pending {
  resolve: (body: SandboxFsResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Worker {
  proc: ChildProcess
  root: string
  pending: Map<number, Pending>
  buffer: string
  nextId: number
  alive: boolean
}

interface SpawnedWorkerProcess {
  proc: ChildProcess
  /**
   * Release ASRT's per-wrap lifecycle bookkeeping once the process has started.
   * The persistent worker has no write-deny mounts of its own, so retaining this
   * lease for its whole lifetime would prevent unrelated one-shot commands from
   * cleaning up their Linux bubblewrap mount points.
   */
  releaseSandbox: () => void
}

// One worker per workspace root, not a single global slot (#i2jsed): threads in
// separate git worktrees have different roots and must be able to browse/preview
// files concurrently without tearing down each other's worker just because the
// renderer's active-thread focus moved.
const liveByRoot = new Map<string, Worker>()
const spawningByRoot = new Map<string, Promise<Worker>>()

function retire(w: Worker): void {
  failWorker(w, new SandboxFsServerUnavailable('worker retired'))
}

function failWorker(w: Worker, err: Error): void {
  if (liveByRoot.get(w.root) === w) liveByRoot.delete(w.root)
  if (!w.alive) return
  w.alive = false
  for (const pending of w.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(err)
  }
  w.pending.clear()
  try {
    w.proc.stdin?.end()
  } catch {
    // already closed
  }
  terminateProcessTree(w.proc)
}

function handleLine(w: Worker, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed: Record<string, unknown>
  try {
    const value = parseJsonUnknown(trimmed)
    if (!isRecord(value)) return
    parsed = value
  } catch {
    return // unframed/garbled — nothing to correlate
  }
  if (typeof parsed['id'] !== 'number') return
  const pending = w.pending.get(parsed['id'])
  if (!pending) return
  w.pending.delete(parsed['id'])
  clearTimeout(pending.timer)
  const { id: _id, ...body } = parsed
  if (typeof body['ok'] !== 'boolean') {
    pending.reject(new SandboxFsServerUnavailable('worker returned an invalid response'))
    return
  }
  const error = body['error']
  pending.resolve({ ...body, ok: body['ok'], ...(typeof error === 'string' ? { error } : {}) })
}

function onData(w: Worker, chunk: string): void {
  w.buffer += chunk
  if (w.buffer.length > MAX_BUFFER_BYTES) {
    failWorker(w, new SandboxFsServerUnavailable('worker response exceeded buffer limit'))
    return
  }
  let nl = w.buffer.indexOf('\n')
  while (nl !== -1) {
    const line = w.buffer.slice(0, nl)
    w.buffer = w.buffer.slice(nl + 1)
    handleLine(w, line)
    nl = w.buffer.indexOf('\n')
  }
}

/** Test seam — swap how the worker subprocess is created (the real path needs a macOS sandbox). */
type WorkerSpawner = (root: string) => Promise<ChildProcess>
let spawnerForTest: WorkerSpawner | null = null
let releaseSandboxForTest: (() => void) | null = null
export function setWorkerSpawnerForTest(fn: WorkerSpawner | null): void {
  spawnerForTest = fn
}

/** Test seam for observing the persistent worker's early ASRT lease release. */
export function setWorkerSandboxReleaseForTest(fn: (() => void) | null): void {
  releaseSandboxForTest = fn
}

async function spawnWorkerProc(root: string): Promise<SpawnedWorkerProcess> {
  if (spawnerForTest) {
    return {
      proc: await spawnerForTest(root),
      releaseSandbox: releaseSandboxForTest ?? ((): void => {}),
    }
  }
  const workerPath = sandboxFsWorkerPath()
  return {
    proc: await spawnInProjectSandbox(process.execPath, [workerPath], {
      cwd: root,
      // Electron must run as Node inside seatbelt; the server flag selects the stdin request loop.
      env: { ELECTRON_RUN_AS_NODE: '1', [SANDBOX_FS_SERVER_ENV]: '1' },
      stdio: 'pipe',
      sandboxConfig: fsServerSandboxOverlay(root, workerPath),
    }),
    releaseSandbox: afterSandboxedCommand,
  }
}

async function spawnWorker(root: string): Promise<Worker> {
  const spawned = await spawnWorkerProc(root)
  // fsServerSandboxOverlay is read-only and creates no mandatory write-deny
  // mount points. Release its ASRT counter immediately: keeping it active for
  // the whole app session makes cleanup from short Git/fs commands defer
  // forever, leaving .bashrc/.gitconfig/etc. visible as untracked files.
  spawned.releaseSandbox()
  const { proc } = spawned
  if (!proc.stdout || !proc.stdin) {
    terminateProcessTree(proc)
    throw new SandboxFsServerUnavailable('worker pipes unavailable')
  }
  const w: Worker = { proc, root, pending: new Map(), buffer: '', nextId: 1, alive: true }
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', (chunk: string) => {
    onData(w, chunk)
  })
  proc.on('exit', () => {
    failWorker(w, new SandboxFsServerUnavailable('worker exited'))
  })
  proc.on('error', (err) => {
    failWorker(w, new SandboxFsServerUnavailable(err.message))
  })
  return w
}

function getOrSpawn(root: string): Promise<Worker> {
  const existing = liveByRoot.get(root)
  if (existing && existing.alive) return Promise.resolve(existing)
  const inFlight = spawningByRoot.get(root)
  if (inFlight) return inFlight
  const promise = spawnWorker(root)
    .then((w) => {
      liveByRoot.set(root, w)
      spawningByRoot.delete(root)
      return w
    })
    .catch((err: unknown) => {
      spawningByRoot.delete(root)
      throw err instanceof Error ? err : new SandboxFsServerUnavailable(String(err))
    })
  spawningByRoot.set(root, promise)
  return promise
}

function sendToWorker(w: Worker, request: Record<string, unknown>): Promise<SandboxFsResponse> {
  if (!w.alive || !w.proc.stdin || w.proc.stdin.destroyed) {
    return Promise.reject(new SandboxFsServerUnavailable('worker not writable'))
  }
  const id = w.nextId++
  return new Promise<SandboxFsResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Treat a missed deadline as a wedged worker: tear it down so the next call respawns,
      // and let this request fall back to a one-shot spawn.
      if (w.pending.has(id))
        failWorker(w, new SandboxFsServerUnavailable('worker request timed out'))
    }, REQUEST_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    w.pending.set(id, { resolve, reject, timer })
    const line = `${JSON.stringify({ id, ...request })}\n`
    w.proc.stdin?.write(line, (err) => {
      if (err && w.pending.delete(id)) {
        clearTimeout(timer)
        reject(new SandboxFsServerUnavailable(err.message))
      }
    })
  })
}

/**
 * Send one request to the persistent worker, spawning it if needed. Throws
 * {@link SandboxFsServerUnavailable} on any transport failure so the caller can fall back.
 */
export async function requestViaServer(
  request: Record<string, unknown>,
  requestedRoot?: string,
): Promise<SandboxFsResponse> {
  if (request['op'] === 'writeFile') {
    throw new Error('persistent sandbox fs server is read-only')
  }
  const root = requestedRoot ?? getWorkspaceRoot()
  if (!root) throw new SandboxFsServerUnavailable('no workspace open')
  let worker: Worker
  try {
    worker = await getOrSpawn(root)
  } catch (err) {
    throw err instanceof SandboxFsServerUnavailable
      ? err
      : new SandboxFsServerUnavailable(err instanceof Error ? err.message : String(err))
  }
  return sendToWorker(worker, request)
}

/** Tear all workers down, across every root (app shutdown / sandbox reset). */
export function shutdownSandboxFsServer(): void {
  for (const w of [...liveByRoot.values()]) retire(w)
  for (const promise of [...spawningByRoot.values()]) {
    void promise.then(retire).catch(() => {})
  }
  spawningByRoot.clear()
}

/** Test hook — report whether any worker is currently live. */
export function isSandboxFsServerLive(): boolean {
  for (const w of liveByRoot.values()) if (w.alive) return true
  return false
}
