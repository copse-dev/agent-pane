import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KnowledgeAttachment } from '@shared/knowledge/attachments.ts'
import { knowledgeDir } from './knowledge-store.ts'

/**
 * File storage for knowledge-note attachments (issue #556 — roadmap items
 * accepting pasted files/images). Payloads are ordinary files under
 * `<knowledge dir>/attachments/<noteId>/<attachmentId>-<name>`, so they are as
 * portable and browsable as the OKF notes that reference them; the note's
 * frontmatter `attachments` field (shared/knowledge/attachments.ts) is the
 * metadata source of truth, and disk filenames derive from that metadata alone
 * so a read never needs a directory scan.
 */

/** Renderer-supplied payload for a new attachment: a base64 data URL, the form
 * FileReader/canvas produce and the composer's image pipeline already uses. */
export interface NewKnowledgeAttachmentInput {
  name: string
  mimeType: string
  dataUrl: string
}

// Note ids are store-generated UUIDs and attachment ids are generated here, but
// both cross IPC (and a note file can be hand-authored), so nothing path-like
// may ever reach a filesystem path.
function assertSafePathSegment(segment: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) || segment.includes('..')) {
    throw new Error(`Invalid ${what} for attachment storage: ${JSON.stringify(segment)}`)
  }
}

function noteAttachmentsDir(noteId: string): string {
  assertSafePathSegment(noteId, 'note id')
  return join(knowledgeDir(), 'attachments', noteId)
}

function sanitizeFileName(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64)
  return safe || 'attachment'
}

/** Disk filename derived only from stored metadata, so reads reconstruct it. */
function attachmentFileName(att: Pick<KnowledgeAttachment, 'id' | 'name'>): string {
  assertSafePathSegment(att.id, 'attachment id')
  return `${att.id}-${sanitizeFileName(att.name)}`
}

function decodeDataUrl(dataUrl: string): { mimeType: string; data: Buffer } | null {
  if (!dataUrl.startsWith('data:')) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const header = dataUrl.slice(5, comma)
  if (!header.endsWith(';base64')) return null
  const mimeType = header.split(';')[0] ?? ''
  return { mimeType, data: Buffer.from(dataUrl.slice(comma + 1), 'base64') }
}

// The stored mime type is re-embedded into data: URLs on read, so only accept a
// syntactically valid type/subtype; anything else degrades to octet-stream.
function sanitizeMimeType(mimeType: string): string {
  return /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream'
}

/** Write new attachment payloads for a note, returning their metadata (to be
 * serialized into the note's `attachments` field by the caller). */
export function saveKnowledgeAttachments(
  noteId: string,
  inputs: NewKnowledgeAttachmentInput[],
): KnowledgeAttachment[] {
  if (inputs.length === 0) return []
  const dir = noteAttachmentsDir(noteId)
  // Decode and validate every payload before writing the first file, so a bad
  // input mid-list rejects the whole batch without leaving partial files that
  // no metadata references.
  const decoded = inputs.map((input) => {
    const payload = decodeDataUrl(input.dataUrl)
    if (!payload) {
      throw new Error(`Attachment ${JSON.stringify(input.name)} is not a base64 data URL.`)
    }
    const att: KnowledgeAttachment = {
      id: randomUUID(),
      name: input.name.trim() || 'attachment',
      mimeType: sanitizeMimeType(input.mimeType || payload.mimeType),
      size: payload.data.length,
    }
    return { att, data: payload.data }
  })
  mkdirSync(dir, { recursive: true })
  return decoded.map(({ att, data }) => {
    writeFileSync(join(dir, attachmentFileName(att)), data)
    return att
  })
}

/** An attachment's payload as a base64 data URL, or null if the file is gone. */
export function readKnowledgeAttachmentDataUrl(
  noteId: string,
  att: Pick<KnowledgeAttachment, 'id' | 'name' | 'mimeType'>,
): string | null {
  try {
    const data = readFileSync(join(noteAttachmentsDir(noteId), attachmentFileName(att)))
    return `data:${sanitizeMimeType(att.mimeType)};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

/** Remove specific attachment files (metadata removal is the caller's job). */
export function deleteKnowledgeAttachmentFiles(
  noteId: string,
  attachments: Pick<KnowledgeAttachment, 'id' | 'name'>[],
): void {
  for (const att of attachments) {
    try {
      rmSync(join(noteAttachmentsDir(noteId), attachmentFileName(att)), { force: true })
    } catch {
      // Already gone — the metadata list is what the pane renders from.
    }
  }
}

/** Remove a note's whole attachment directory (used when the note is deleted). */
export function deleteAllKnowledgeAttachments(noteId: string): void {
  let dir: string
  try {
    dir = noteAttachmentsDir(noteId)
  } catch {
    // An id we would never have stored under can't have a directory.
    return
  }
  rmSync(dir, { recursive: true, force: true })
}
