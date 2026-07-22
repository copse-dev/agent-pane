import type { Thread } from '@shared/types'
import { threadToJsonl } from '@shared/threads/export-jsonl.ts'

export {
  THREAD_JSONL_EXPORT_VERSION,
  threadHasExportableContent,
  threadToJsonl,
} from '@shared/threads/export-jsonl.ts'

export function downloadThreadJsonl(thread: Thread): void {
  const body = threadToJsonl(thread)
  const slug = thread.title.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'thread'
  const stamp = new Date().toISOString().slice(0, 10)
  const blob = new Blob([body], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug}-${stamp}.jsonl`
  a.click()
  URL.revokeObjectURL(url)
}
