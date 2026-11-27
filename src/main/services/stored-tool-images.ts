import type { Message, Thread, ToolCall } from '@shared/types'
import { storedToolImageRef } from '@shared/threads/fold.ts'
import {
  isStoredToolImageUrl,
  parseStoredToolImageUrl,
  storedToolImageUrl,
} from '@shared/threads/stored-tool-image.ts'
import { zProjectId, zThreadId } from '../ipc/ipc-guards.ts'
import { readStoredToolImage } from './thread-store.ts'

/**
 * Main's two sides of `stored-tool-image.ts`: what a window is sent, and what is
 * written back from it.
 */

function withRefsInCall(projectId: string, threadId: string, call: ToolCall): ToolCall {
  if (call.images === undefined || call.images.length === 0) return call
  // The display content of an ACP call repeats each image it returned; send the
  // repeat as the same reference, so the window also pairs them by equality.
  const references = new Map<string, string>()
  const images = call.images.map((image) => {
    const ref = storedToolImageRef(image)
    if (ref === undefined) return image
    const url = storedToolImageUrl({ projectId, threadId, ref: ref.ref, sha256: ref.sha256 })
    references.set(image.dataUrl, url)
    return { ...image, dataUrl: url }
  })
  if (references.size === 0) return call
  const content = call.content?.map((item) => {
    if (item.type !== 'content' || item.content.type !== 'image') return item
    const url = references.get(item.content.dataUrl)
    return url === undefined ? item : { ...item, content: { ...item.content, dataUrl: url } }
  })
  return { ...call, images, ...(content !== undefined ? { content } : {}) }
}

/**
 * `messages` as a window should receive them: every tool image this process
 * folded from the thread's own blobs becomes a stored-image reference. Images
 * from a live turn, not yet read back from disk, stay inline. Unchanged messages
 * are returned as they are.
 */
export function withStoredToolImageRefs(
  projectId: string,
  threadId: string,
  messages: readonly Message[],
): Message[] {
  return messages.map((message) => {
    if (!message.toolCalls.some((call) => (call.images?.length ?? 0) > 0)) return message
    const toolCalls = message.toolCalls.map((call) => withRefsInCall(projectId, threadId, call))
    return toolCalls.every((call, index) => call === message.toolCalls[index])
      ? message
      : { ...message, toolCalls }
  })
}

/** {@link withStoredToolImageRefs} for a whole thread. */
export function threadWithStoredToolImageRefs(projectId: string, thread: Thread): Thread {
  const messages = withStoredToolImageRefs(projectId, thread.id, thread.messages)
  return messages.every((message, index) => message === thread.messages[index])
    ? thread
    : { ...thread, messages }
}

/** The image a reference names, or null when it is malformed, gone, or no longer matches. */
export async function readStoredToolImageUrl(url: string): Promise<string | null> {
  const address = parseStoredToolImageUrl(url)
  if (address === null) return null
  const projectId = zProjectId.safeParse(address.projectId)
  const threadId = zThreadId.safeParse(address.threadId)
  if (!projectId.success || !threadId.success) return null
  return readStoredToolImage(projectId.data, threadId.data, {
    ref: address.ref,
    sha256: address.sha256,
  })
}

function callHasReference(call: ToolCall): boolean {
  return (
    (call.images ?? []).some((image) => isStoredToolImageUrl(image.dataUrl)) ||
    (call.content ?? []).some(
      (item) =>
        item.type === 'content' &&
        item.content.type === 'image' &&
        isStoredToolImageUrl(item.content.dataUrl),
    )
  )
}

/** Whether a message a window sent still holds a stored-image reference anywhere. */
export function hasStoredToolImageRefs(message: Message): boolean {
  return message.toolCalls.some(callHasReference)
}

async function resolvedCall(call: ToolCall): Promise<ToolCall> {
  if (!callHasReference(call)) return call
  const reads = new Map<string, Promise<string | null>>()
  const read = (url: string): Promise<string | null> => {
    let pending = reads.get(url)
    if (pending === undefined) {
      pending = readStoredToolImageUrl(url)
      reads.set(url, pending)
    }
    return pending
  }
  // An image whose blob is gone is dropped, never written as its reference.
  const images =
    call.images === undefined
      ? undefined
      : (
          await Promise.all(
            call.images.map(async (image) => {
              if (!isStoredToolImageUrl(image.dataUrl)) return [image]
              const dataUrl = await read(image.dataUrl)
              return dataUrl === null ? [] : [{ ...image, dataUrl }]
            }),
          )
        ).flat()
  const content =
    call.content === undefined
      ? undefined
      : (
          await Promise.all(
            call.content.map(async (item) => {
              if (
                item.type !== 'content' ||
                item.content.type !== 'image' ||
                !isStoredToolImageUrl(item.content.dataUrl)
              ) {
                return [item]
              }
              const dataUrl = await read(item.content.dataUrl)
              return dataUrl === null ? [] : [{ ...item, content: { ...item.content, dataUrl } }]
            }),
          )
        ).flat()
  const { images: _images, content: _content, ...rest } = call
  return {
    ...rest,
    ...(images !== undefined && images.length > 0 ? { images } : {}),
    ...(content !== undefined ? { content } : {}),
  }
}

/**
 * `message` with every stored-image reference a window sent back replaced by
 * the image it names, so the store writes image bytes and never a reference.
 */
export async function withStoredToolImagesResolved(message: Message): Promise<Message> {
  const toolCalls = await Promise.all(message.toolCalls.map((call) => resolvedCall(call)))
  return toolCalls.every((call, index) => call === message.toolCalls[index])
    ? message
    : { ...message, toolCalls }
}

/** {@link withStoredToolImagesResolved} for every message of a thread a window sends. */
export async function threadWithStoredToolImagesResolved<T extends { messages: Message[] }>(
  thread: T,
): Promise<T> {
  const messages = await Promise.all(thread.messages.map((m) => withStoredToolImagesResolved(m)))
  return messages.every((message, index) => message === thread.messages[index])
    ? thread
    : { ...thread, messages }
}
