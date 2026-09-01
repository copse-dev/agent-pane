import { posixQuote } from '../security/safe-install.ts'
import { execOnSshHost } from './remote-fs-exec.ts'

/**
 * Polling stand-in for a remote file watcher.
 *
 * `fs.watch` observes only the local machine, so an SSH workspace cannot notice
 * edits made outside Copse — a `git pull` in a terminal on the remote, or
 * another editor. Copse's own writes already refresh through the write path;
 * this covers the rest.
 *
 * Deliberately *not* a general workspace watcher. Polling a whole remote
 * checkout would cost far more than it returns; this polls only the paths the
 * renderer explicitly subscribed through `fs:watch` (open editors — a handful
 * at a time), batched into one `stat` per host per tick over the connection
 * that is already open. A streaming watcher replaces this later; the
 * subscribe/unsubscribe shape here is the one it inherits.
 */

/**
 * Poll cadence. Slow enough to be invisible on a shared host and over a slow
 * link, fast enough that an external edit lands within a few seconds.
 */
const POLL_INTERVAL_MS = 4_000

/**
 * Paths per `stat` invocation. A subscription set larger than this is split so
 * the remote command line cannot approach `ARG_MAX`.
 */
const STAT_CHUNK_SIZE = 100

export interface RemotePollTarget {
  hostId: string
  /** Remote workspace root — the exec cwd. Paths are absolute, so this is context, not resolution. */
  remoteRoot: string
  /** Absolute path on the remote host. */
  absPath: string
}

/** Notified when a watched path's mtime or size changed since the previous tick. */
export type RemotePollHandler = (key: string, size: number) => void

interface Entry extends RemotePollTarget {
  key: string
  onChange: RemotePollHandler
  /** `mtime|size` as of the last tick, or null when the path did not exist then. */
  signature: string | null
  /**
   * False until a tick has recorded a baseline. A path's first sighting is not
   * a change — without this every newly opened editor would fire immediately.
   */
  primed: boolean
}

type ExecFn = (hostId: string, remoteRoot: string, command: string) => Promise<{ stdout: string }>

const defaultExec: ExecFn = (hostId, remoteRoot, command) =>
  execOnSshHost(hostId, remoteRoot, command)

let execImpl: ExecFn = defaultExec
const entries = new Map<string, Entry>()
let timer: NodeJS.Timeout | null = null
let inFlight = false

/** Test hook — poll without an SSH host. Pass null to restore the real transport. */
export function setRemotePollExecForTest(fn: ExecFn | null): void {
  execImpl = fn ?? defaultExec
}

/**
 * One `stat` covering every path in the chunk, in whichever flavour the remote
 * has.
 *
 * GNU and BSD `stat` share no format flag, and the remote may be either (Linux
 * hosts and macOS/BSD hosts are both ordinary SSH targets), so try GNU first
 * and fall back. The fallback is safe in both directions: on BSD, `-c` is not a
 * valid option and prints nothing; on GNU, `-f` means `--file-system` and its
 * default output shares no line shape with the format below, so
 * {@link parseStatOutput} discards it. The cost of a remote that needs the
 * fallback is one extra process per tick, not an extra round trip.
 */
export function buildStatCommand(paths: string[]): string {
  const quoted = paths.map((path) => posixQuote(path)).join(' ')
  return (
    `stat -c '%n|%Y|%s' -- ${quoted} 2>/dev/null || ` +
    `stat -f '%N|%m|%z' -- ${quoted} 2>/dev/null`
  )
}

/**
 * Parse `path|mtime|size` lines into signatures.
 *
 * The path is matched greedily and the two numeric fields are anchored to the
 * end, so a filename containing `|` still parses. Any line that does not match
 * — a stray error, or GNU's `--file-system` output from the fallback branch —
 * is discarded rather than guessed at.
 */
export function parseStatOutput(stdout: string): Map<string, { signature: string; size: number }> {
  const parsed = new Map<string, { signature: string; size: number }>()
  for (const line of stdout.split('\n')) {
    const match = /^(.*)\|(\d+)\|(\d+)$/.exec(line.trim())
    if (!match) continue
    const [, path, mtime, size] = match
    if (path === undefined || mtime === undefined || size === undefined) continue
    parsed.set(path, { signature: `${mtime}|${size}`, size: Number(size) })
  }
  return parsed
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

async function pollHost(hostId: string, hostEntries: Entry[]): Promise<void> {
  // Absolute paths make the exec cwd irrelevant to resolution; it only has to
  // be a directory the host can enter, so any subscriber's root will do.
  const remoteRoot = hostEntries[0]?.remoteRoot
  if (remoteRoot === undefined) return
  const byPath = new Map(hostEntries.map((entry) => [entry.absPath, entry]))

  for (const paths of chunk([...byPath.keys()], STAT_CHUNK_SIZE)) {
    const { stdout } = await execImpl(hostId, remoteRoot, buildStatCommand(paths))
    const stats = parseStatOutput(stdout)
    for (const path of paths) {
      const entry = byPath.get(path)
      // Dropped mid-tick by an `fs:unwatch`; its signature is no longer wanted.
      if (!entry || !entries.has(entry.key)) continue
      const stat = stats.get(path)
      const signature = stat?.signature ?? null
      // A vanished path is recorded but not reported: the local watcher stays
      // silent on delete too, and recording null means a later recreate still
      // reads as a change.
      const changed = entry.primed && signature !== null && signature !== entry.signature
      entry.signature = signature
      entry.primed = true
      if (changed && stat) entry.onChange(entry.key, stat.size)
    }
  }
}

/**
 * Stat every subscribed path once, grouped into one command per host.
 *
 * Exported for tests: the interval is an implementation detail, but the tick
 * itself is the unit worth asserting on.
 */
export async function pollRemoteFilesOnce(): Promise<void> {
  const byHost = new Map<string, Entry[]>()
  for (const entry of entries.values()) {
    const list = byHost.get(entry.hostId)
    if (list) list.push(entry)
    else byHost.set(entry.hostId, [entry])
  }
  for (const [hostId, hostEntries] of byHost) {
    try {
      await pollHost(hostId, hostEntries)
    } catch (err) {
      // A dropped connection or a host that went away must not kill the timer:
      // the next tick retries, and reconnect resumes without re-subscribing.
      console.warn('[copse-panel] remote file poll failed for', hostId, err)
    }
  }
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(() => {
    // Skip rather than queue. On a link slower than the interval, overlapping
    // ticks would pile up behind each other and never drain.
    if (inFlight) return
    inFlight = true
    void pollRemoteFilesOnce().finally(() => {
      inFlight = false
    })
  }, POLL_INTERVAL_MS)
  // Never hold the process open for a poll.
  timer.unref()
}

/** Idempotently subscribe `key` to changes of a remote path. */
export function watchRemotePath(
  key: string,
  target: RemotePollTarget,
  onChange: RemotePollHandler,
): void {
  if (entries.has(key)) return
  entries.set(key, { ...target, key, onChange, signature: null, primed: false })
  ensureTimer()
}

export function unwatchRemotePath(key: string): void {
  entries.delete(key)
  if (entries.size === 0) stopRemoteFilePolling()
}

export function stopRemoteFilePolling(): void {
  entries.clear()
  if (timer) clearInterval(timer)
  timer = null
  inFlight = false
}
