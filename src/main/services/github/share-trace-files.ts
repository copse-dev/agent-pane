import type { Thread } from '@shared/types'
import { COPSE_PRODUCT_REPO_SLUG, COPSE_PRODUCT_REPO_URL } from '@shared/github/product-repo.ts'
import { threadToJsonl } from '@shared/threads/export-jsonl.ts'

/** Repo-relative directory where share-trace PRs drop their attachments. */
export const SHARE_TRACE_DIR = 'debug-traces'

/** Soft cap so a runaway export fails fast instead of uploading tens of MB. */
export const SHARE_TRACE_MAX_TOTAL_BYTES = 25 * 1024 * 1024

export interface ShareTraceFile {
  /** Path relative to the repository root. */
  path: string
  content: string
}

export interface ShareTracePackage {
  branch: string
  title: string
  body: string
  files: ShareTraceFile[]
  /** Directory under {@link SHARE_TRACE_DIR} for this share. */
  folder: string
}

export interface ShareTraceStoreFiles {
  /** Raw `events.jsonl` spine from the on-disk thread store, when present. */
  eventsJsonl?: string
  /** Raw `meta.json` from the on-disk thread store, when present. */
  metaJson?: string
}

function slugSegment(value: string, max = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return slug || 'thread'
}

function shortThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'thread'
}

function stampParts(now: Date): { date: string; time: string } {
  const iso = now.toISOString()
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 19).replace(/:/g, ''),
  }
}

/** Build the branch name / folder / PR metadata for a share-trace upload. */
export function buildShareTracePackage(
  thread: Thread,
  store: ShareTraceStoreFiles = {},
  now: Date = new Date(),
): ShareTracePackage {
  const { date, time } = stampParts(now)
  const shortId = shortThreadId(thread.id)
  const folder = `${date}-${shortId}`
  const branch = `debug/trace-${shortId}-${date.replace(/-/g, '')}-${time}`
  const titleSlug = slugSegment(thread.title)
  const title = `debug: share trace ${shortId} (${titleSlug})`

  const files: ShareTraceFile[] = [
    {
      path: `${SHARE_TRACE_DIR}/${folder}/thread.jsonl`,
      content: threadToJsonl(thread),
    },
  ]
  if (store.eventsJsonl !== undefined) {
    files.push({
      path: `${SHARE_TRACE_DIR}/${folder}/events.jsonl`,
      content: store.eventsJsonl,
    })
  }
  if (store.metaJson !== undefined) {
    files.push({
      path: `${SHARE_TRACE_DIR}/${folder}/meta.json`,
      content: store.metaJson,
    })
  }

  const attached = files.map((f) => `- \`${f.path}\``).join('\n')
  const body = [
    '## Debug trace share',
    '',
    'Attached from the Copse footer **Share trace** action for maintainer debugging.',
    '',
    '### Thread',
    '',
    `- **Id:** \`${thread.id}\``,
    `- **Title:** ${thread.title || '(untitled)'}`,
    `- **Status:** ${thread.status}`,
    `- **Model:** ${thread.model ?? '(unset)'}`,
    `- **Messages:** ${String(thread.messages.length)}`,
    '',
    '### Files',
    '',
    attached,
    '',
    '### Notes',
    '',
    `- Portable export is analyzer-ready: \`npm run analyze:thread -- ${SHARE_TRACE_DIR}/${folder}/thread.jsonl\`.`,
    `- \`events.jsonl\` / \`meta.json\` are the on-disk store spine when available ([thread store format](${COPSE_PRODUCT_REPO_URL}/blob/main/docs/thread-store-format.md)).`,
    `- Traces may contain workspace paths, prompts, and tool output — treat as private.`,
    '',
    `Target repo: \`${COPSE_PRODUCT_REPO_SLUG}\`.`,
  ].join('\n')

  return { branch, title, body, files, folder }
}

/** Sum UTF-8 byte lengths; used to enforce {@link SHARE_TRACE_MAX_TOTAL_BYTES}. */
export function shareTraceTotalBytes(files: ShareTraceFile[]): number {
  return files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)
}
