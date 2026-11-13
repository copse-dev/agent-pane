import type { TranscriptAttachment } from './thread.ts'

export interface ProtectedPromptContextEntry {
  label: string
  value: string
}

/** Main-owned data shown in the isolated prompt window. */
export interface ProtectedPromptSeed {
  projectLabel: string
  threadLabel: string
  text: string
  model?: string
  imageCount: number
  /** Original model-facing image data, rendered only inside the sandboxed review window. */
  images: string[]
  attachments: TranscriptAttachment[]
  /** Every renderer-supplied turn control that can change model behaviour. */
  context: ProtectedPromptContextEntry[]
  kind: 'human' | 'machine'
}

export interface ProtectedPromptSubmission {
  text: string
}

/** Renderer hint used only to reconcile the already-visible optimistic bubble. */
export interface ProtectedHumanTurnDisplay {
  messageId?: string
}
