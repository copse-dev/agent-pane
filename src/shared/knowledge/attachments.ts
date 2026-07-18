/**
 * Attachment metadata for knowledge notes (roadmap items today — issue #556).
 * The binary payloads live as plain files under
 * `<knowledge dir>/attachments/<noteId>/` (knowledge-attachments.ts); the note's
 * frontmatter carries this metadata list JSON-encoded in a single `attachments`
 * scalar field, staying inside the knowledge store's string-only `fields` model
 * so a note file still names everything it owns.
 */
export interface KnowledgeAttachment {
  id: string
  /** Original filename, shown as the chip label. */
  name: string
  mimeType: string
  /** Decoded payload size in bytes. */
  size: number
}

/** The `fields` key holding the JSON-encoded {@link KnowledgeAttachment} list. */
export const ATTACHMENTS_FIELD = 'attachments'

/** Cap per note — attachments ride through IPC as base64 data URLs. */
export const MAX_NOTE_ATTACHMENTS = 20

export function isImageAttachment(att: Pick<KnowledgeAttachment, 'mimeType'>): boolean {
  return att.mimeType.startsWith('image/')
}

function isAttachment(value: unknown): value is KnowledgeAttachment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { mimeType?: unknown }).mimeType === 'string' &&
    typeof (value as { size?: unknown }).size === 'number'
  )
}

/** Parse an `attachments` field value. Missing/malformed JSON (or a hand-edited
 * note) degrades to "no attachments" rather than breaking the note. */
export function parseKnowledgeAttachments(value: string | undefined): KnowledgeAttachment[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isAttachment).map(({ id, name, mimeType, size }) => ({
    id,
    name,
    mimeType,
    size,
  }))
}

export function serializeKnowledgeAttachments(attachments: KnowledgeAttachment[]): string {
  return JSON.stringify(
    attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
  )
}
