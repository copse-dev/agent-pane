import type { StreamChunk } from '@shared/types'

/**
 * Side-channel an agent run uses to stream output back to whatever is hosting it.
 *
 * A turn produces {@link StreamChunk}s (text, tool calls, usage, todos, …) as it
 * progresses. In the Electron app the host forwards them to the renderer over the
 * `agent:chunk` IPC channel; a headless host (a unit test, or a future ACP server
 * entry point) can collect them in memory or remap them to another transport.
 *
 * Depending on this interface instead of `BrowserWindow` is what lets the agent
 * core run without Electron — the host is the only Electron-specific seam the run
 * needs.
 */
export interface AgentHost {
  /** Deliver a stream chunk for the given thread to the host. */
  emit(threadId: string, chunk: StreamChunk): void
}
