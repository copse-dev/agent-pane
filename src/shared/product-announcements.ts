import { z } from 'zod'

/** Durable per-profile acknowledgements, separate from app version numbers. */
export const ANNOUNCEMENT_HISTORY_SETTING = 'acknowledgedProductAnnouncements'
export const announcementHistorySchema = z.array(z.string().min(1).max(128)).max(4096)

export function parseAnnouncementHistory(value: unknown): string[] {
  const parsed = announcementHistorySchema.safeParse(value)
  return parsed.success ? [...new Set(parsed.data)] : []
}
