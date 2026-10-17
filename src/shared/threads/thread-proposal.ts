import type { ToolCall } from '@shared/types'
import { THREAD_PROPOSAL_TOOL } from '@copse/thread-store/thread-proposal.ts'
import { isCopseToolCall } from '@shared/tools/copse-tool-call.ts'

// Lives in `@copse/thread-store`; this re-export keeps app imports stable.
export * from '@copse/thread-store/thread-proposal.ts'

// ACP-bridged agents report the raw MCP name (`mcp__copse__propose_thread` or
// `copse.propose_thread`) rather than the bare tool name, in either `name` or
// `programmaticName`. Mirrors `isReviewerInputCall` in `reviewer-input.ts`.
export function isThreadProposalCall(call: ToolCall): boolean {
  return isCopseToolCall(call, THREAD_PROPOSAL_TOOL)
}
