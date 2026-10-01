import type { TranscriptAttachment } from './thread.ts'

/** Main-process decision for one host-native machine continuation. */
export type MachineDispatchResult = 'completed' | 'duplicate' | 'stale' | 'budget-exhausted'

/** Transcript presentation kept separate from the model-facing run payload. */
export interface MachineTurnDisplay {
  content: string
  attachments?: TranscriptAttachment[]
  startingCommit?: string
  dirty?: boolean
}

/** Validated renderer-to-main request for a host-native continuation. */
export interface MachineAgentRunRequest {
  projectId: string
  threadId: string
  operationId: string
  turnTreeId: string
  payload: string
  display: MachineTurnDisplay
}
