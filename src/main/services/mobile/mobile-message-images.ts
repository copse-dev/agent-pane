import type { AcpContentBlock, AcpToolCallContent, ToolCall } from '@shared/types'

type ImageMessage = {
  images?: readonly string[]
  contentBlocks?: readonly AcpContentBlock[]
  toolCalls: readonly Pick<ToolCall, 'images' | 'content'>[]
}

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,/i

/** Keep image bytes out of the polled thread response; fetch each visible image on demand. */
export function mobileMessageImages(message: ImageMessage): string[] {
  const urls = [
    ...(message.images ?? []),
    ...(message.contentBlocks ?? []).flatMap((block) =>
      block.type === 'image' ? [block.dataUrl] : [],
    ),
    ...message.toolCalls.flatMap((tool) => [
      ...(tool.images ?? []).map((image) => image.dataUrl),
      ...(tool.content ?? []).flatMap((entry: AcpToolCallContent) =>
        entry.type === 'content' && entry.content.type === 'image' ? [entry.content.dataUrl] : [],
      ),
    ]),
  ]
  return [...new Set(urls)].filter((url) => url.length <= 20_000_000 && IMAGE_DATA_URL.test(url))
}
