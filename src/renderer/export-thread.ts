import type { Thread, ToolCall } from '@shared/types'
import { threadToJsonl } from '@shared/threads/export-jsonl.ts'
import { isStoredToolImageUrl } from '@shared/threads/stored-tool-image.ts'
import type { ApiClient } from '../preload/api.d.ts'

export {
  THREAD_JSONL_EXPORT_VERSION,
  threadHasExportableContent,
  threadToJsonl,
} from '@shared/threads/export-jsonl.ts'

/** Shared stem for a thread's downloads, so `.jsonl` and `.zip` sit together. */
export function threadExportBaseName(thread: Thread, now: Date = new Date()): string {
  const slug = thread.title.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'thread'
  return `${slug}-${now.toISOString().slice(0, 10)}`
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

type StoredImageReader = (url: string) => Promise<string | null>

/**
 * `thread` with each large tool image the window holds as a `copse-stored-image:`
 * reference read back from the store, so an export carries the images rather
 * than references only this profile can resolve. One that cannot be read is
 * left out.
 */
export async function threadWithStoredImages(
  thread: Thread,
  read: StoredImageReader,
): Promise<Thread> {
  const references = new Set<string>()
  for (const message of thread.messages)
    for (const call of message.toolCalls) {
      for (const image of call.images ?? [])
        if (isStoredToolImageUrl(image.dataUrl)) references.add(image.dataUrl)
      for (const item of call.content ?? [])
        if (
          item.type === 'content' &&
          item.content.type === 'image' &&
          isStoredToolImageUrl(item.content.dataUrl)
        )
          references.add(item.content.dataUrl)
    }
  if (references.size === 0) return thread
  const images = new Map<string, string | null>()
  // One at a time: each is a multi-megabyte IPC reply.
  for (const reference of references) images.set(reference, await read(reference))
  const withImages = (call: ToolCall): ToolCall => {
    const callImages = call.images?.flatMap((image) => {
      if (!isStoredToolImageUrl(image.dataUrl)) return [image]
      const dataUrl = images.get(image.dataUrl) ?? null
      return dataUrl === null ? [] : [{ ...image, dataUrl }]
    })
    const content = call.content?.flatMap((item) => {
      if (
        item.type !== 'content' ||
        item.content.type !== 'image' ||
        !isStoredToolImageUrl(item.content.dataUrl)
      )
        return [item]
      const dataUrl = images.get(item.content.dataUrl) ?? null
      return dataUrl === null ? [] : [{ ...item, content: { ...item.content, dataUrl } }]
    })
    const { images: _images, content: _content, ...rest } = call
    return {
      ...rest,
      ...(callImages !== undefined && callImages.length > 0 ? { images: callImages } : {}),
      ...(content !== undefined ? { content } : {}),
    }
  }
  return {
    ...thread,
    messages: thread.messages.map((message) => ({
      ...message,
      toolCalls: message.toolCalls.map(withImages),
    })),
  }
}

export async function downloadThreadJsonl(api: ApiClient, thread: Thread): Promise<void> {
  const complete = await threadWithStoredImages(thread, (url) => api.threads.storedToolImage(url))
  const blob = new Blob([threadToJsonl(complete)], { type: 'application/x-ndjson' })
  download(blob, `${threadExportBaseName(complete)}.jsonl`)
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
