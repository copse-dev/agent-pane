import type { Thread } from '@shared/types'
import { threadToJsonl } from '@shared/threads/export-jsonl.ts'
import type { ApiClient } from '../preload/api.d.ts'

export {
  THREAD_JSONL_EXPORT_VERSION,
  threadHasExportableContent,
  threadToJsonl,
} from '@shared/threads/export-jsonl.ts'

/** Shared stem for a thread's downloads, so `.jsonl` and `.zip` sit together. */
export function threadExportBaseName(thread: Thread, now: Date = new Date()): string {
  // Letters and digits of any script survive: an ASCII-only class reduced a
  // title written in another script to a bare "-". Cut by code point so the
  // limit cannot split a surrogate pair.
  const slug = Array.from(thread.title.replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '-'))
    .slice(0, 40)
    .join('')
  const stem = /[\p{L}\p{N}]/u.test(slug) ? slug : 'thread'
  return `${stem}-${now.toISOString().slice(0, 10)}`
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadThreadJsonl(thread: Thread): void {
  const blob = new Blob([threadToJsonl(thread)], { type: 'application/x-ndjson' })
  download(blob, `${threadExportBaseName(thread)}.jsonl`)
}

/**
 * Download the thread's whole store directory as a zip. Unlike the JSONL — which
 * the renderer can build from state it already holds — the directory lives in
 * the chat store, so the main process assembles the archive.
 */
export async function downloadThreadArchive(
  api: ApiClient,
  projectId: string,
  thread: Thread,
): Promise<void> {
  const { bytes } = await api.threads.exportArchive(projectId, thread.id)
  download(new Blob([bytes], { type: 'application/zip' }), `${threadExportBaseName(thread)}.zip`)
}
