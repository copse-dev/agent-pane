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

export interface MobileChatRequest {
  projectId: string
  threadId: string | null
  text: string
  image?: string
}

export type MobileChatResult =
  | { ok: true; threadId: string; queued: boolean }
  | { ok: false; error: string }
