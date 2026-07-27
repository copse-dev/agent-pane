import { ATTACHMENTS_FIELD, parseKnowledgeAttachments } from '@shared/knowledge/attachments.ts'
import { isRoadmapComplexity } from '@shared/roadmap/complexity.ts'
import {
  RoadmapExporter,
  type RoadmapExportFormat,
  type RoadmapExportItem,
  type RoadmapExportProject,
  type RoadmapExportResult,
} from '@shared/roadmap/export.ts'
import { isRoadmapFit } from '@shared/roadmap/fit.ts'
import { isRoadmapReviewVerdict } from '@shared/roadmap/review.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import { readKnowledgeAttachmentDataUrl } from './storage/knowledge-attachments.ts'
import { loadKnowledgeNotes, type KnowledgeNote } from './storage/knowledge-store.ts'

/**
 * Wires the pure `RoadmapExporter` (shared/roadmap/export.ts) to this app's
 * knowledge store, for the currently active project (issue #556 follow-up).
 * Roadmap items and attachments are scoped to the active project the same
 * way every other roadmap service is (`knowledge-store.ts`'s
 * `workspaceNamespace()`); callers should confirm the intended project is
 * active before calling, exactly as the `roadmap:*` IPC handlers already do.
 */

function decodeBase64DataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

function noteToExportItem(note: KnowledgeNote): RoadmapExportItem {
  const fields = note.fields
  const complexity = isRoadmapComplexity(fields['complexity']) ? fields['complexity'] : null
  const fit = isRoadmapFit(fields['fit']) ? fields['fit'] : null
  const reviewVerdict = isRoadmapReviewVerdict(fields['reviewVerdict'])
    ? fields['reviewVerdict']
    : null
  const attachments = parseKnowledgeAttachments(fields[ATTACHMENTS_FIELD]).flatMap((attachment) => {
    const dataUrl = readKnowledgeAttachmentDataUrl(note.id, attachment)
    if (!dataUrl) return []
    return [
      {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        data: decodeBase64DataUrl(dataUrl),
      },
    ]
  })
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    status: note.status,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    notes: fields['notes'] ?? null,
    issue: fields['issue'] ?? null,
    complexity,
    fit,
    fitDetail: fields['fitDetail'] ?? null,
    reviewVerdict,
    reviewDetail: fields['reviewDetail'] ?? null,
    reviewAt: fields['reviewAt'] ?? null,
    attachments,
  }
}

/** Render the active project's roadmap into the requested export format. */
export function buildRoadmapExport(
  project: RoadmapExportProject,
  format: RoadmapExportFormat,
  exportedAt: string,
): RoadmapExportResult {
  const items = loadKnowledgeNotes(ROADMAP_TYPE).map(noteToExportItem)
  return new RoadmapExporter(project, items, { exportedAt }).export(format)
}
