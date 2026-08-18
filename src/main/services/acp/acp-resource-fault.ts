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

/** One log line explaining what Copse saw and what it is about to do about it. */
export function formatAcpResourceFault(command: string, fault: AcpResourceFault): string {
  const scope =
    fault.code === 'ENFILE'
      ? 'the machine is out of file descriptors'
      : 'the agent process hit its open-file limit'
  return (
    `[acp:${command}] ${scope} (${fault.code}, ${describeLimit(inheritedOpenFileLimit())}) — ` +
    `the process can no longer open files: ${fault.detail}`
  )
}

/**
 * What to say when replacing the process cannot help: it faulted so soon after
 * starting that it cannot have leaked its way there, so the ceiling it inherited
 * is the whole problem. Raising it is a machine-level change, outside anything
 * Copse can do to its own children.
 */
export function formatOpenFileCeilingWarning(command: string): string {
  return (
    `[acp:${command}] a freshly started agent is already out of file descriptors ` +
    `(${describeLimit(inheritedOpenFileLimit())}), so its replacement would be too — ` +
    `raise the limit for the desktop session instead (macOS: launchctl limit maxfiles; ` +
    `Linux: the login's nofile limit), then restart Copse`
  )
}
