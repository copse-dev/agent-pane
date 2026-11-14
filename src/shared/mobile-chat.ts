/** Authenticated human submission, delivered only to the primary desktop renderer. */
export interface MobileChatCommand {
  id: string
  projectId: string
  threadId: string
  /** Main reserved this exact target because the phone requested a new thread. */
  createThread: boolean
  text: string
  image?: string
  /** Main-owned model snapshot at the authenticated HTTP boundary. */
  model?: string
  expiresAt: number
}

export interface MobilePlanReview {
  planId: string
  revision: number
  contentHash: string
  /** Main-issued receipt for status, approval, comments and completion too. */
  authorityHash: string
}

export interface MobileChatRequest {
  projectId: string
  threadId: string | null
  text: string
  image?: string
  /** Exact main-served plan revision the authenticated phone reviewed. */
  planReview?: MobilePlanReview
}

export type MobileChatResult =
  | { ok: true; threadId: string; queued: boolean }
  | { ok: false; error: string }
