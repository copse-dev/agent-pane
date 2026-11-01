import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { splitLoadReplay } from './acp-session-reattach.ts'

// Bounds apply across session IDs, including IDs the opening response never selects.
// Bytes are a conservative UTF-16 serialized-size estimate, not a heap measurement.
export const ACP_STARTUP_BUFFER_MAX_UPDATES = 4096
export const ACP_STARTUP_BUFFER_MAX_BYTES = 16 * 1024 * 1024

export class AcpStartupBuffer {
  private readonly pending = new Map<string, SessionUpdate[]>()
  private count = 0
  private bytes = 0
  private replaySessionId: string | null = null
  private foundConversation = false

  beginReplay(sessionId: string): void {
    this.clear()
    this.replaySessionId = sessionId
  }

  enqueue(sessionId: string, update: SessionUpdate): Error | null {
    if (sessionId === this.replaySessionId) {
      const replay = splitLoadReplay([update])
      this.foundConversation ||= replay.foundConversation
      if (replay.replayed > 0) return null
    }
    const bytes = (JSON.stringify(update).length + sessionId.length) * 2
    if (
      this.count >= ACP_STARTUP_BUFFER_MAX_UPDATES ||
      this.bytes + bytes > ACP_STARTUP_BUFFER_MAX_BYTES
    ) {
      this.clear()
      return new Error('ACP startup buffer limit exceeded')
    }
    const pending = this.pending.get(sessionId) ?? []
    pending.push(update)
    this.pending.set(sessionId, pending)
    this.count++
    this.bytes += bytes
    return null
  }

  replayFoundConversation(): boolean {
    return this.foundConversation
  }

  take(sessionId: string): SessionUpdate[] {
    const updates = this.pending.get(sessionId) ?? []
    this.clear()
    return updates
  }

  clear(): void {
    this.pending.clear()
    this.count = 0
    this.bytes = 0
    this.replaySessionId = null
    this.foundConversation = false
  }
}
