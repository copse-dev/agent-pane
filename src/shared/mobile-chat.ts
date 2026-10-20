/** Authenticated human submission, delivered only to the primary desktop renderer. */
export interface MobileChatCommand {
  id: string
  projectId: string
  threadId: string | null
  text: string
  image?: string
  expiresAt: number
}

export type MobileChatResult =
  | { ok: true; threadId: string; queued: boolean }
  | { ok: false; error: string }
