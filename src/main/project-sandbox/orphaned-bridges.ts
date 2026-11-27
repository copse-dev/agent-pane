import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * ASRT's Linux network bridge is a `socat` child of the app process:
 *
 *   socat UNIX-LISTEN:/tmp/claude-http-<id>.sock,fork,reuseaddr TCP:localhost:<port>,…
 *
 * `SandboxManager.reset()` kills it, and `shutdownProjectSandbox` calls that —
 * but only on a graceful quit. Anything that takes the app down without running
 * `before-quit` (a SIGKILL, a renderer crash taking the process with it, the e2e
 * teardown's TERM-then-immediate-KILL) leaves the bridge alive and reparented to
 * init. One e2e shard accumulated ~45 of them, one per spec, because nothing in
 * the app reclaims a bridge whose owner is already gone.
 *
 * A CI-side `pkill` can only clean up between jobs. This reclaims them in the
 * app, so a long-lived machine converges no matter who killed the last run.
 */

/** Only bridges for this platform's tmpdir, so we never match another host's. */
function bridgeSocketPrefix(): string {
  return `UNIX-LISTEN:${tmpdir()}/claude-`
}

/**
 * Whether a process is an ASRT bridge nobody owns any more.
 *
 * The `ppid === 1` test is what makes this safe to run while other instances of
 * the app are live: a bridge whose parent is still running has that parent's
 * pid, and only an orphan is reparented to init. Without it this would kill a
 * concurrent instance's working bridge — which on a CI runner reused across
 * shards is precisely the process a sibling job depends on.
 */
export function isOrphanedBridge(cmdline: string, ppid: number, socketPrefix: string): boolean {
  if (ppid !== 1) return false
  return cmdline.includes(socketPrefix)
}

interface ProcEntry {
  pid: number
  ppid: number
  cmdline: string
}

/** Read `/proc` into (pid, ppid, cmdline) triples, skipping anything unreadable. */
function readProcessTable(): ProcEntry[] {
  const entries: ProcEntry[] = []
  let pids: string[]
  try {
    pids = readdirSync('/proc')
  } catch {
    return entries
  }
  for (const name of pids) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0) continue
    try {
      // `/proc/<pid>/cmdline` is NUL-separated; join with spaces so the socat
      // arguments read as one line, matching what `ps` would show.
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
      if (!cmdline) continue
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      // Fields after the comm field, which is parenthesised and may itself
      // contain spaces — so split from the last ')' rather than the first space.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(afterComm[1])
      if (!Number.isInteger(ppid)) continue
      entries.push({ pid, ppid, cmdline })
    } catch {
      // Process exited between readdir and read, or we cannot see it. Skip.
    }
  }
  return entries
}

/**
 * ASRT's macOS violation monitor is a `log` child of the app process:
 *
 *   log stream --predicate (eventMessage ENDSWITH "_<random>_SBX") --style compact
 *
 * `SandboxManager.reset()` stops it, but after a crash or SIGKILL it is
 * reparented to launchd. No later event can end in that launch's random suffix,
 * so the orphan never writes, never meets a closed pipe, and never exits.
 */
const LOG_MONITOR_COMMAND =
  /^(?:\/usr\/bin\/)?log stream --predicate \(eventMessage ENDSWITH "_[a-z0-9]+_SBX"\) --style compact$/

/** Whether a process is an ASRT log monitor nobody owns any more (see {@link isOrphanedBridge}). */
export function isOrphanedLogMonitor(command: string, ppid: number): boolean {
  return ppid === 1 && LOG_MONITOR_COMMAND.test(command.trim())
}

/** This user's processes from `ps`, skipping anything unreadable. */
function readPsTable(): ProcEntry[] {
  let output: string
  try {
    output = execFileSync('ps', ['-x', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }
  const entries: ProcEntry[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), cmdline: match[3] ?? '' })
  }
  return entries
}

/** The orphans to reclaim on this platform: Linux network bridges, macOS log monitors. */
function orphanedSandboxProcesses(): number[] {
  if (process.platform === 'linux') {
    const prefix = bridgeSocketPrefix()
    return readProcessTable()
      .filter((entry) => isOrphanedBridge(entry.cmdline, entry.ppid, prefix))
      .map((entry) => entry.pid)
  }
  if (process.platform === 'darwin') {
    return readPsTable()
      .filter((entry) => isOrphanedLogMonitor(entry.cmdline, entry.ppid))
      .map((entry) => entry.pid)
  }
  return []
}

/**
 * Kill ASRT helpers (Linux bridges, macOS log monitors) whose owning process
 * is gone. Best-effort and silent about individual failures: a process we
 * cannot signal (another user's) is not our problem, and this must never be
 * able to fail a startup or a shutdown.
 *
 * Returns the pids it signalled, for logging and tests.
 */
export function reapOrphanedSandboxBridges(): number[] {
  const reaped: number[] = []
  for (const pid of orphanedSandboxProcesses()) {
    if (pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
      reaped.push(pid)
    } catch {
      // Already gone, or not ours to signal.
    }
  }
  return reaped
}
