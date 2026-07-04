import type { AgentHost } from '@shared/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import { recordThreadModel } from './thread-models.ts'
import { recordAgentUsageChunk } from './storage/usage-ledger.ts'

/** Side effects for agent stream chunks before forwarding to the renderer. */
export function createAgentChunkSink(
  threadId: string,
  host: AgentHost,
): (chunk: StreamChunk) => void {
  return (chunk) => {
    if (chunk.type === 'usage') {
      recordAgentUsageChunk(threadId, chunk)
      recordThreadModel(threadId, chunk.model)
    }
    host.emit(threadId, chunk)
  }
}
