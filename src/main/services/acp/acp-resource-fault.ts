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

/** One log line explaining what Copse saw and what it is about to do about it. */
export function formatAcpResourceFault(command: string, fault: AcpResourceFault): string {
  const scope =
    fault.code === 'ENFILE'
      ? 'the machine is out of file descriptors'
      : 'the agent process hit its open-file limit'
  return (
    `[acp:${command}] ${scope} (${fault.code}) — the process can no longer open files ` +
    `and will be replaced before the next turn: ${fault.detail}`
  )
}
