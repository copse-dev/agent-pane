import type { LLMMessage, UserContent } from '@shared/types'
import type {
  PackModelAttachment,
  PackModelHistoryMessage,
  PackModelTurn,
} from './pack-tool-protocol.ts'

const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_MESSAGES = 32
const MAX_HISTORY_CHARS = 64 * 1024
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/

export function packModelPromptText(content: UserContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export function packModelAttachments(
  content: UserContent,
  supportsImages: boolean,
): PackModelAttachment[] {
  if (typeof content === 'string') return []
  const images = content.filter(
    (block): block is { type: 'image'; dataUrl: string } => block.type === 'image',
  )
  if (images.length === 0) return []
  if (!supportsImages) throw new Error('The selected pack model does not accept image attachments.')
  if (images.length > MAX_ATTACHMENTS) {
    throw new Error(`Pack model turns accept at most ${String(MAX_ATTACHMENTS)} images.`)
  }
  let totalBytes = 0
  return images.map((image) => {
    const match = IMAGE_DATA_URL.exec(image.dataUrl)
    if (!match?.[1] || !match[2]) {
      throw new Error('Pack model image must be a base64 PNG, JPEG, WebP, or GIF data URL.')
    }
    const decoded = Buffer.from(match[2], 'base64')
    if (decoded.byteLength === 0 || decoded.toString('base64') !== match[2]) {
      throw new Error('Pack model image must contain canonical base64 data.')
    }
    totalBytes += decoded.byteLength
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error('Pack model image attachments exceed the 8 MB turn limit.')
    }
    let mimeType: PackModelAttachment['mimeType']
    switch (match[1]) {
      case 'image/png':
      case 'image/jpeg':
      case 'image/webp':
      case 'image/gif':
        mimeType = match[1]
        break
      default:
        throw new Error('Pack model image type is unsupported.')
    }
    return { mimeType, dataBase64: match[2] }
  })
}

function messageText(message: LLMMessage): PackModelHistoryMessage | null {
  switch (message.role) {
    case 'system':
      return null
    case 'user':
      return {
        role: 'user',
        text:
          typeof message.content === 'string'
            ? message.content
            : message.content
                .map((block) =>
                  block.type === 'text' ? block.text : '[Image omitted from transcript handoff]',
                )
                .join('\n'),
      }
    case 'assistant':
      return {
        role: 'assistant',
        text:
          typeof message.content === 'string'
            ? message.content
            : message.content
                .map((call) => `[Tool call: ${call.name} ${JSON.stringify(call.args)}]`)
                .join('\n'),
      }
    case 'tool':
      return {
        role: 'tool',
        text: message.toolResults.map((result) => result.result).join('\n'),
      }
  }
}

/** Newest-first budgeting, restored to chronological order for the pack. */
export function boundedPackModelHistory(
  messages: readonly LLMMessage[],
): PackModelHistoryMessage[] {
  const selected: PackModelHistoryMessage[] = []
  let remaining = MAX_HISTORY_CHARS
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < MAX_HISTORY_MESSAGES;
    index--
  ) {
    const message = messages[index]
    if (!message) continue
    const normalized = messageText(message)
    if (!normalized || normalized.text.length === 0) continue
    const text = normalized.text.slice(-remaining)
    if (text.length === 0) break
    selected.push({ ...normalized, text })
    remaining -= text.length
    if (remaining === 0) break
  }
  return selected.reverse()
}

export function buildPackModelTurn(input: {
  threadId: string
  prompt: UserContent
  priorMessages: readonly LLMMessage[]
  supportsImages: boolean
}): PackModelTurn {
  return {
    threadId: input.threadId,
    prompt: packModelPromptText(input.prompt),
    attachments: packModelAttachments(input.prompt, input.supportsImages),
    history: boundedPackModelHistory(input.priorMessages),
  }
}
