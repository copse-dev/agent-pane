import type { RoadmapComplexity } from './complexity.ts'
import type { RoadmapFit } from './fit.ts'
import type { RoadmapReviewVerdict } from './review.ts'
import { ZipBuilder } from './zip-writer.ts'

/**
 * Deterministic, reusable exporter for one project's roadmap (issue #556
 * follow-up). Pure and side-effect free: given the same project, items and
 * `exportedAt`, `RoadmapExporter.export()` always returns byte-identical
 * output — no `Date.now()`, no random ids, no reliance on object-iteration
 * order beyond the arrays the caller passes in. Main-process callers are
 * responsible for gathering `RoadmapExportItem[]` from the knowledge store
 * (see `src/main/services/roadmap-export.ts`) and resolving attachment
 * bytes; this class only renders and (when files are present) bundles them.
 *
 * Format choice:
 *  - `md` / `html` / `jsonl` render one self-describing document that links
 *    attachments by relative path (`attachments/<itemId>/<attachmentId>-<name>`).
 *    When any item carries attachments, `export()` bundles the document and
 *    every attachment file into a deterministic zip so those relative paths
 *    resolve; with no attachments it returns the raw document instead.
 *  - `mhtml` is inherently a single-file container (MIME multipart/related),
 *    so attachments are embedded inline as base64 parts rather than zipped —
 *    `export()` never bundles an mhtml result.
 */

export interface RoadmapExportProject {
  id: string
  name: string
  path: string
}

export interface RoadmapExportAttachment {
  id: string
  name: string
  mimeType: string
  data: Uint8Array
}

export interface RoadmapExportItem {
  id: string
  title: string
  body: string
  status: string | null
  createdAt: string
  updatedAt: string
  notes: string | null
  issue: string | null
  complexity: RoadmapComplexity | null
  fit: RoadmapFit | null
  fitDetail: string | null
  reviewVerdict: RoadmapReviewVerdict | null
  reviewDetail: string | null
  reviewAt: string | null
  attachments: readonly RoadmapExportAttachment[]
}

export const ROADMAP_EXPORT_FORMATS = ['md', 'html', 'mhtml', 'jsonl'] as const
export type RoadmapExportFormat = (typeof ROADMAP_EXPORT_FORMATS)[number]

export function isRoadmapExportFormat(value: unknown): value is RoadmapExportFormat {
  return typeof value === 'string' && ROADMAP_EXPORT_FORMATS.some((entry) => entry === value)
}

export interface RoadmapExportResult {
  format: RoadmapExportFormat
  /** Download filename — a `.zip` name when `bundled`, else the document's own extension. */
  filename: string
  mimeType: string
  data: Uint8Array
  /** True when attachments were bundled into a zip alongside the rendered document. */
  bundled: boolean
  /** Relative paths of every file represented by `data` (just the document name when not bundled). */
  files: readonly string[]
}

/** Bump when the rendered document shape changes in a way re-importers should know about. */
export const ROADMAP_EXPORT_VERSION = 1

function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'project'
}

function sanitizeAttachmentFileName(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64)
  return safe || 'attachment'
}

function attachmentRelativePath(itemId: string, attachment: RoadmapExportAttachment): string {
  return `attachments/${itemId}/${attachment.id}-${sanitizeAttachmentFileName(attachment.name)}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(data: Uint8Array): string {
  let result = ''
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i] ?? 0
    const b1 = data[i + 1] ?? 0
    const b2 = data[i + 2] ?? 0
    const chunkLength = data.length - i
    result += BASE64_CHARS.charAt(b0 >> 2)
    result += BASE64_CHARS.charAt(((b0 & 0x03) << 4) | (b1 >> 4))
    result += chunkLength > 1 ? BASE64_CHARS.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : '='
    result += chunkLength > 2 ? BASE64_CHARS.charAt(b2 & 0x3f) : '='
  }
  return result
}

/** Wrap base64 text at 76 columns (RFC 2045), CRLF-joined for MIME body parts. */
function base64Mime(data: Uint8Array): string {
  const base64 = bytesToBase64(data)
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76))
  return lines.join('\r\n')
}

interface MetaLine {
  label: string
  value: string | null
}

function itemMetaLines(item: RoadmapExportItem): MetaLine[] {
  return [
    { label: 'id', value: item.id },
    { label: 'status', value: item.status },
    { label: 'complexity', value: item.complexity },
    { label: 'fit', value: item.fit },
    { label: 'fit detail', value: item.fitDetail },
    { label: 'review', value: item.reviewVerdict },
    { label: 'reviewed at', value: item.reviewAt },
    { label: 'review detail', value: item.reviewDetail },
    { label: 'issue', value: item.issue },
    { label: 'notes', value: item.notes },
    { label: 'created', value: item.createdAt },
    { label: 'updated', value: item.updatedAt },
  ]
}

export class RoadmapExporter {
  private readonly project: RoadmapExportProject
  private readonly items: readonly RoadmapExportItem[]
  private readonly exportedAt: string

  constructor(
    project: RoadmapExportProject,
    items: readonly RoadmapExportItem[],
    options: { exportedAt: string },
  ) {
    this.project = project
    this.items = items
    this.exportedAt = options.exportedAt
  }

  export(format: RoadmapExportFormat): RoadmapExportResult {
    switch (format) {
      case 'md':
        return this.exportDocument('md', 'md', 'text/markdown', this.renderMarkdown())
      case 'html':
        return this.exportDocument('html', 'html', 'text/html', this.renderHtml())
      case 'jsonl':
        return this.exportDocument('jsonl', 'jsonl', 'application/x-ndjson', this.renderJsonl())
      case 'mhtml':
        return this.exportMhtml()
    }
  }

  private hasAnyAttachments(): boolean {
    return this.items.some((item) => item.attachments.length > 0)
  }

  private baseFilename(): string {
    return `${projectSlug(this.project.name)}-roadmap-${this.exportedAt.slice(0, 10)}`
  }

  private exportDocument(
    format: RoadmapExportFormat,
    ext: string,
    mimeType: string,
    text: string,
  ): RoadmapExportResult {
    const docName = `roadmap.${ext}`
    const docBytes = new TextEncoder().encode(text)
    if (!this.hasAnyAttachments()) {
      return {
        format,
        filename: `${this.baseFilename()}.${ext}`,
        mimeType,
        data: docBytes,
        bundled: false,
        files: [docName],
      }
    }
    const zip = new ZipBuilder()
    zip.addFile(docName, docBytes)
    const attachmentPaths: string[] = []
    for (const item of this.items) {
      for (const attachment of item.attachments) {
        const path = attachmentRelativePath(item.id, attachment)
        zip.addFile(path, attachment.data)
        attachmentPaths.push(path)
      }
    }
    return {
      format,
      filename: `${this.baseFilename()}.zip`,
      mimeType: 'application/zip',
      data: zip.build(),
      bundled: true,
      files: [docName, ...attachmentPaths],
    }
  }

  private exportMhtml(): RoadmapExportResult {
    // Real MIME boundary tokens only need to avoid colliding with the
    // encoded body; base64 output never contains "=_" so a fixed marker is
    // safe here without scanning rendered content for it.
    const boundary = '----=_CopseRoadmapExport'
    const html = this.renderHtml()
    const attachmentFiles: string[] = []
    const parts: string[] = [
      'MIME-Version: 1.0',
      `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'Content-Location: roadmap.html',
      '',
      base64Mime(new TextEncoder().encode(html)),
    ]
    for (const item of this.items) {
      for (const attachment of item.attachments) {
        const path = attachmentRelativePath(item.id, attachment)
        attachmentFiles.push(path)
        parts.push(
          `--${boundary}`,
          `Content-Type: ${attachment.mimeType}`,
          'Content-Transfer-Encoding: base64',
          `Content-Location: ${path}`,
          '',
          base64Mime(attachment.data),
        )
      }
    }
    parts.push(`--${boundary}--`, '')
    return {
      format: 'mhtml',
      filename: `${this.baseFilename()}.mhtml`,
      mimeType: 'application/x-mimearchive',
      data: new TextEncoder().encode(parts.join('\r\n')),
      bundled: false,
      files: ['roadmap.html', ...attachmentFiles],
    }
  }

  private renderMarkdown(): string {
    const lines: string[] = [
      `# Roadmap — ${this.project.name}`,
      '',
      `- Project: ${this.project.name} (\`${this.project.id}\`)`,
      `- Path: \`${this.project.path}\``,
      `- Exported: ${this.exportedAt}`,
      `- Items: ${String(this.items.length)}`,
      '',
    ]
    for (const item of this.items) {
      lines.push(`## ${item.title}`, '')
      for (const { label, value } of itemMetaLines(item)) {
        if (value !== null) lines.push(`- ${label}: ${value}`)
      }
      lines.push('', item.body.trim(), '')
      if (item.attachments.length > 0) {
        lines.push('Attachments:')
        for (const attachment of item.attachments) {
          const path = attachmentRelativePath(item.id, attachment)
          lines.push(
            `- [${attachment.name}](${path}) (${attachment.mimeType}, ${String(attachment.data.length)} bytes)`,
          )
        }
        lines.push('')
      }
    }
    return lines.join('\n')
  }

  private renderHtml(): string {
    const itemsHtml = this.items
      .map((item) => {
        const meta = itemMetaLines(item)
          .filter((line) => line.value !== null)
          .map(
            ({ label, value }) =>
              `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '')}</dd>`,
          )
          .join('')
        const attachments =
          item.attachments.length === 0
            ? ''
            : `<ul class="attachments">${item.attachments
                .map((attachment) => {
                  const path = attachmentRelativePath(item.id, attachment)
                  return `<li><a href="${escapeHtml(path)}">${escapeHtml(attachment.name)}</a> (${escapeHtml(
                    attachment.mimeType,
                  )}, ${String(attachment.data.length)} bytes)</li>`
                })
                .join('')}</ul>`
        return `<article>
  <h2>${escapeHtml(item.title)}</h2>
  <dl>${meta}</dl>
  <pre>${escapeHtml(item.body)}</pre>
  ${attachments}
</article>`
      })
      .join('\n')
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Roadmap — ${escapeHtml(this.project.name)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-top: 1px solid #ddd; padding-top: 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem; margin: 0.5rem 0; }
  dt { font-weight: 600; color: #555; }
  dd { margin: 0; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f6f6f6; padding: 0.75rem; border-radius: 6px; }
  ul.attachments { margin: 0.5rem 0 0; padding-left: 1.25rem; }
</style>
</head>
<body>
<h1>Roadmap — ${escapeHtml(this.project.name)}</h1>
<p>
  Project: <code>${escapeHtml(this.project.id)}</code> · Path: <code>${escapeHtml(this.project.path)}</code><br>
  Exported: ${escapeHtml(this.exportedAt)} · Items: ${String(this.items.length)}
</p>
${itemsHtml}
</body>
</html>
`
  }

  private renderJsonl(): string {
    const lines: string[] = [
      JSON.stringify({
        type: 'roadmap',
        exportVersion: ROADMAP_EXPORT_VERSION,
        project: this.project,
        exportedAt: this.exportedAt,
        itemCount: this.items.length,
      }),
    ]
    for (const item of this.items) {
      lines.push(
        JSON.stringify({
          type: 'item',
          id: item.id,
          title: item.title,
          body: item.body,
          status: item.status,
          complexity: item.complexity,
          fit: item.fit,
          fitDetail: item.fitDetail,
          reviewVerdict: item.reviewVerdict,
          reviewDetail: item.reviewDetail,
          reviewAt: item.reviewAt,
          issue: item.issue,
          notes: item.notes,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          attachments: item.attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.data.length,
            path: attachmentRelativePath(item.id, attachment),
          })),
        }),
      )
    }
    return lines.join('\n') + '\n'
  }
}
