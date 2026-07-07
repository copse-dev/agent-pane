import type { AgentStreamChunk } from './wire-types.ts'

/**
 * Side-channel an agent run uses to stream output back to whatever is hosting it.
 *
 * A turn produces stream chunks (text, tool calls, usage, subagents, …) as it
 * progresses. In the Electron app the host forwards them to the renderer over the
 * `agent:chunk` IPC channel; a headless host (a unit test, or a future ACP server
 * entry point) can collect them in memory or remap them to another transport.
 *
 * Depending on this interface instead of `BrowserWindow` is what lets the agent
 * core run without Electron — the host is the only Electron-specific seam the run
 * needs.
 *
 * `TChunk` defaults to what the loop itself emits ({@link AgentStreamChunk}); a
 * host that also carries app-level orchestration events (todo updates, review
 * status, …) instantiates it with its wider chunk union — e.g. the app's
 * `AgentHost<StreamChunk>`.
 */
export interface AgentHost<TChunk = AgentStreamChunk> {
  /** Deliver a stream chunk for the given thread to the host. */
  emit(threadId: string, chunk: TChunk): void
}
