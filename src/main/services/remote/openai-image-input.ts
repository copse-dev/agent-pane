import type { PromptPayload } from '@shared/remote-agent-stream.ts'

type Image = NonNullable<PromptPayload['images']>[number]
const MAX_IMAGES = 5
const MAX_BYTES = 20 * 1024 * 1024

/** Product transfer budget, not a claim about the model's vision limits. */
export function openAiImageUrls(current: Image[], prior: Image[] = []): string[] {
  if (current.length > MAX_IMAGES) throw new Error('Attach at most 5 images per hosted message.')
  const encode = (image: Image): string => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType))
      throw new Error('Hosted image input supports PNG, JPEG, WebP and GIF.')
    if (
      image.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      image.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
      !image.data
    )
      throw new Error('Invalid or oversized hosted image input.')
    return `data:${image.mimeType};base64,${image.data}`
  }
  const urls = current.map(encode)
  let bytes = current.reduce((sum, image) => sum + Buffer.byteLength(image.data, 'base64'), 0)
  if (bytes > MAX_BYTES)
    throw new Error('Hosted image attachments exceed the 20 MiB message budget.')
  for (const image of [...prior].reverse()) {
    if (urls.length === MAX_IMAGES) break
    const size = Buffer.byteLength(image.data, 'base64')
    if (bytes + size > MAX_BYTES) continue
    const url = encode(image)
    urls.unshift(url)
    bytes += size
  }
  return urls
}
