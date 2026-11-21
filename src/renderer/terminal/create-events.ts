interface PendingEvents {
  output: string
  exitCode: number | null
}

// Retain at most 16 streams and the last 64 Ki UTF-16 units of each while
// create is pending. Startup output must not become an unbounded event queue.
const MAX_SESSIONS = 16
const MAX_OUTPUT = 64 * 1024

/**
 * Notifications can arrive before terminal.create returns its session ID.
 * Keep a short, pane-local handoff window; only the exact ID from the create
 * response may claim a stream. Unmatched notifications never select a tab.
 */
export class TerminalCreateEvents {
  private pending = 0
  private readonly sessions = new Map<string, PendingEvents>()

  begin(): () => void {
    this.pending += 1
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.pending -= 1
      if (this.pending === 0) this.clear()
    }
  }

  output(sessionId: string, data: string): void {
    if (this.pending === 0) return
    const events = this.get(sessionId)
    if (events.exitCode === null) events.output = (events.output + data).slice(-MAX_OUTPUT)
  }

  exit(sessionId: string, code: number): void {
    if (this.pending === 0) return
    this.get(sessionId).exitCode ??= code
  }

  take(sessionId: string): PendingEvents | undefined {
    const events = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    return events
  }

  clear(): void {
    this.sessions.clear()
  }

  private get(sessionId: string): PendingEvents {
    let events = this.sessions.get(sessionId)
    if (!events) {
      if (this.sessions.size === MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined) this.sessions.delete(oldest)
      }
      events = { output: '', exitCode: null }
      this.sessions.set(sessionId, events)
    }
    return events
  }
}
