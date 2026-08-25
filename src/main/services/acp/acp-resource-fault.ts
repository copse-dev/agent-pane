/**
 * File-descriptor exhaustion inside an external ACP agent process.
 *
 * A pooled agent process (`acp-session-pool.ts`) serves every turn of a thread
 * until the thread goes idle, so an adapter that leaks handles keeps leaking
 * for as long as Copse keeps the process warm. Claude Code's settings watchers
 * are the usual canary:
 *
 *   Settings watcher error for ~/.claude/settings.json:
 *   Error: EMFILE: too many open files, watch
 *
 * The process does not exit when this happens — it keeps answering prompts,
 * minus whatever it can no longer open (settings reloads, file reads, MCP
 * servers), so nothing else in the pool notices. Copse cannot fix the leak from
 * outside the agent, but it owns the process lifetime: treat the fault as
 * poison on the pooled session so the next acquire replaces the process (and
 * resumes the same agent session where the agent supports it), which reclaims
 * every leaked descriptor without costing the user the thread's context.
 */

export interface AcpResourceFault {
  /** `EMFILE` — this process's descriptor limit; `ENFILE` — the whole machine's. */
  code: 'EMFILE' | 'ENFILE'
  /** The agent's own stderr line, trimmed and clamped, for the log. */
  detail: string
}

/**
 * A fault as reported by a live agent, carrying the ceiling that agent was
 * running under. Only the transport knows which machine that is — a local agent
 * inherits this process's limits, one over SSH runs under the remote login's —
 * so the description is attached where the fault is captured rather than
 * guessed at by whoever reads it later.
 */
export interface AcpAgentResourceFault extends AcpResourceFault {
  limitLabel: string
}

const DETAIL_LIMIT = 200

/**
 * Both errnos report the same phrasing through libuv and the C library, and the
 * phrase is what keeps this from firing on an agent that merely prints the
 * errno name (a transcript quoting a stack trace, say).
 */
const OUT_OF_DESCRIPTORS = /too many open files/i

/** Find the first descriptor-exhaustion line in captured agent stderr. */
export function detectAcpResourceFault(stderr: string): AcpResourceFault | null {
  for (const line of stderr.split('\n')) {
    if (!OUT_OF_DESCRIPTORS.test(line)) continue
    const trimmed = line.trim()
    return {
      code: /\bENFILE\b/.test(trimmed) ? 'ENFILE' : 'EMFILE',
      detail: trimmed.length > DETAIL_LIMIT ? `${trimmed.slice(0, DETAIL_LIMIT)}…` : trimmed,
    }
  }
  return null
}

/**
 * How much recent stderr a watcher keeps. Chunks arrive on arbitrary boundaries,
 * so the phrase that names the fault routinely lands across two of them; a
 * window this size spans any realistic split while staying trivial to rescan.
 */
const STDERR_WINDOW = 4096

export interface StderrFaultWatcher {
  /** Feed one stderr chunk. Returns the fault only on the chunk that reveals it. */
  push: (chunk: string) => AcpAgentResourceFault | null
  /** The fault this agent has reported, if any. */
  current: () => AcpAgentResourceFault | null
}

/**
 * Watch an agent's stderr for descriptor exhaustion across chunk boundaries.
 * Shared by every transport that captures stderr — local, sandboxed and SSH —
 * so remote agents are diagnosed as precisely as local ones.
 */
export function createStderrFaultWatcher(limitLabel: string): StderrFaultWatcher {
  let window = ''
  let fault: AcpAgentResourceFault | null = null
  return {
    push: (chunk: string): AcpAgentResourceFault | null => {
      if (fault) return null
      window = (window + chunk).slice(-STDERR_WINDOW)
      const found = detectAcpResourceFault(window)
      if (!found) return null
      fault = { ...found, limitLabel }
      // The window has served its purpose; the first fault is the one reported.
      window = ''
      return fault
    },
    current: () => fault,
  }
}

/** The slice of a stderr stream this module needs; `child.stderr` satisfies it. */
export interface AgentStderrSource {
  on: (event: 'data', listener: (chunk: Buffer) => void) => unknown
}

export interface AgentStderrWatchOptions {
  /** Log prefix identifying the agent and how it was reached, e.g. `acp-ssh:codex`. */
  prefix: string
  command: string
  /** The ceiling this agent runs under — see {@link AcpAgentResourceFault}. */
  limitLabel: string
  /** Called with every raw chunk, for a caller that keeps its own stderr tail. */
  onText?: (text: string) => void
}

/**
 * Relay an agent's stderr to the log and watch it for descriptor exhaustion.
 * Every transport that captures stderr goes through here, so a remote agent is
 * diagnosed exactly as precisely as a local one — including a fault phrase
 * split across two chunks, which is why the watcher keeps a window.
 */
export function watchAgentStderr(
  stderr: AgentStderrSource | null | undefined,
  options: AgentStderrWatchOptions,
): StderrFaultWatcher {
  const watcher = createStderrFaultWatcher(options.limitLabel)
  stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    options.onText?.(text)
    const line = text.trimEnd()
    if (line) console.warn(`[${options.prefix}] ${line}`)
    const fault = watcher.push(text)
    if (fault) console.warn(formatAcpResourceFault(options.command, fault))
  })
  return watcher
}

/**
 * The descriptor limits a spawned agent inherits — this process's own, since a
 * child starts from the parent's. Read from Node's diagnostic report, the only
 * `getrlimit` this runtime exposes; the report is built on demand and cached,
 * because a limit does not change under a running process.
 *
 * The numbers are what separates the two causes of the same errno. A ceiling of
 * a few hundred (macOS hands GUI apps a soft limit of 256) is the cause all by
 * itself, and no amount of restarting agents will help. A ceiling in the
 * thousands means the agent really did open that many, which is a leak inside
 * it. Note that a Node-based agent raises its own soft limit to the hard limit
 * at startup, so it is the HARD limit that bounds one of those; an agent
 * written in anything else is bounded by the soft limit it inherited.
 */
export interface OpenFileLimit {
  soft: number | null
  hard: number | null
}

let cachedLimit: OpenFileLimit | null = null

function limitValue(value: unknown): number | null {
  // A real bound is a number; POSIX reports an absent one as "unlimited".
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOpenFileLimit(): OpenFileLimit {
  const unknownLimit: OpenFileLimit = { soft: null, hard: null }
  let report: unknown
  try {
    report = process.report.getReport()
  } catch {
    // Best-effort diagnostics: never let a report failure break a spawn path.
    return unknownLimit
  }
  if (typeof report !== 'object' || report === null || !('userLimits' in report)) {
    return unknownLimit
  }
  const limits = report.userLimits
  if (typeof limits !== 'object' || limits === null || !('open_files' in limits)) {
    return unknownLimit
  }
  const openFiles = limits.open_files
  if (typeof openFiles !== 'object' || openFiles === null) return unknownLimit
  return {
    soft: 'soft' in openFiles ? limitValue(openFiles.soft) : null,
    hard: 'hard' in openFiles ? limitValue(openFiles.hard) : null,
  }
}

export function inheritedOpenFileLimit(): OpenFileLimit {
  cachedLimit ??= readOpenFileLimit()
  return cachedLimit
}

function describeLimit(limit: OpenFileLimit): string {
  const soft = limit.soft === null ? 'unlimited' : String(limit.soft)
  const hard = limit.hard === null ? 'unlimited' : String(limit.hard)
  return `inherited open-file limit ${soft} soft / ${hard} hard`
}

/** One log line explaining what Copse saw, under the limit the agent ran with. */
export function formatAcpResourceFault(command: string, fault: AcpAgentResourceFault): string {
  const scope =
    fault.code === 'ENFILE'
      ? 'the machine is out of file descriptors'
      : 'the agent process hit its open-file limit'
  return (
    `[acp:${command}] ${scope} (${fault.code}, ${fault.limitLabel}) — ` +
    `the process can no longer open files: ${fault.detail}`
  )
}

/** How a locally spawned agent's ceiling reads in a log: this process's own. */
export function localOpenFileLimitLabel(): string {
  return describeLimit(inheritedOpenFileLimit())
}

/**
 * How a remote agent's ceiling reads. Copse has not measured the remote login's
 * limit, and reporting this machine's in its place would name the wrong number
 * on the wrong host, so the label says whose limit it is and stops there.
 */
export const REMOTE_OPEN_FILE_LIMIT_LABEL = "the remote login's own open-file limit"

/**
 * What to say when replacing the process cannot help: a freshly spawned agent
 * was out of descriptors just as fast, so the ceiling both of them started from
 * is the whole problem. Raising it is a machine-level change, outside anything
 * Copse can do to its own children.
 */
export function formatOpenFileCeilingWarning(command: string): string {
  return (
    `[acp:${command}] a replacement agent ran out of file descriptors just as fast ` +
    `(${describeLimit(inheritedOpenFileLimit())}), so respawning cannot fix this — ` +
    `raise the limit for the desktop session instead (macOS: launchctl limit maxfiles; ` +
    `Linux: the login's nofile limit), then restart Copse`
  )
}

/**
 * The last fault Copse could not repair by replacing the process, kept for
 * `/checkup`. A log line is where this is noticed by whoever is watching the
 * console; the checkup is where a user who only sees a misbehaving agent can
 * find out why, so the condition has to outlive the moment it was detected.
 */
let unrepairableFault: { command: string; fault: AcpAgentResourceFault } | null = null

export function noteUnrepairableOpenFileFault(command: string, fault: AcpAgentResourceFault): void {
  unrepairableFault = { command, fault }
}

export function unrepairableOpenFileFault(): {
  command: string
  fault: AcpAgentResourceFault
} | null {
  return unrepairableFault
}

/** Test seam: the record is process-wide, so a test that sets it must clear it. */
export function clearUnrepairableOpenFileFault(): void {
  unrepairableFault = null
}
