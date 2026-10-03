import type { Message, Thread } from '@shared/types'

/** One message as presented by the history editor. Order is owned by the transcript. */
export interface ThreadHistoryDraftMessage {
  id: string
  role: Message['role']
  content: string
  included: boolean
  hasToolCalls: boolean
  reconstructionWarning?: string
}

/** Authoritative main-process snapshot used to open the editor without stale renderer state. */
export interface ThreadHistorySnapshot {
  revision: string
  title: string
  messages: ThreadHistoryDraftMessage[]
  canUndo: boolean
  /** Rebuilding would drop context that exists outside the visible transcript. */
  blockedReason?: string
}

export interface ThreadHistoryEditRequest {
  expectedRevision: string
  messages: Array<Pick<ThreadHistoryDraftMessage, 'id' | 'content' | 'included'>>
}

export interface ThreadHistoryEditResult {
  thread: Thread
  revision: string
  canUndo: boolean
}
