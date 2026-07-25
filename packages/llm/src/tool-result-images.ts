import type { LLMMessage, ToolResult, ToolResultImage, UserContent } from './wire-types.ts'

/**
 * Turning images a tool produced into something each provider will accept.
 *
 * Anthropic lets a `tool_result` block carry `image` blocks directly, which is
 * the faithful representation: the pictures belong to the call that produced
 * them. The OpenAI-shaped APIs (chat completions and responses) only accept a
 * string as a tool/function output, so there the images have to arrive as a
 * separate user message immediately after the tool message — the model still
 * sees them in the right position in the transcript, just attributed to the
 * conversation rather than to the call.
 *
 * Both shapes label each image with its name first, so a model reading four
 * near-identical screenshots can say "at 00:01:23.450 the dialog is open"
 * instead of "in the third image".
 */

const IMAGE_MIME = /^data:(image\/[\w.+-]+);base64,/

/** Reject anything that isn't a base64 image data URL before it reaches a provider. */
export function isSupportedToolResultImage(image: ToolResultImage): boolean {
  return IMAGE_MIME.test(image.dataUrl)
}

function labelledBlocks(
  images: readonly ToolResultImage[],
): Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }> {
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }> = []
  for (const image of images) {
    if (!isSupportedToolResultImage(image)) continue
    if (image.name) blocks.push({ type: 'text', text: image.name })
    blocks.push({ type: 'image', dataUrl: image.dataUrl })
  }
  return blocks
}

/**
 * Content blocks for a provider that accepts images inside a tool result.
 * Returns null when the result has no usable images, so callers keep sending the
 * plain string form (cheaper, and unchanged for every existing tool).
 */
export function toolResultContentBlocks(
  result: ToolResult,
): Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }> | null {
  const images = result.images ?? []
  if (images.length === 0) return null
  const blocks = labelledBlocks(images)
  if (blocks.length === 0) return null
  return [{ type: 'text', text: result.result }, ...blocks]
}

/**
 * Drop tool-result images from a history snapshot before it is written to disk.
 *
 * A frame set is megabytes of base64 per call, and the on-disk history is
 * rewritten after every turn — persisting them would grow a thread's sidecar
 * without bound to keep pictures the model can regenerate. The text result names
 * every frame's path, so after a reload the model re-reads the ones it needs
 * (or re-runs the tool) instead of replaying stale base64.
 *
 * Returns the same array when nothing carries images, so the common case does
 * no copying.
 */
export function stripToolResultImages(messages: readonly LLMMessage[]): LLMMessage[] {
  const hasImages = messages.some(
    (m) => m.role === 'tool' && m.toolResults.some((r) => (r.images?.length ?? 0) > 0),
  )
  if (!hasImages) return [...messages]
  return messages.map((m) => {
    if (m.role !== 'tool') return m
    return {
      role: 'tool' as const,
      toolResults: m.toolResults.map(({ toolCallId, result }) => ({ toolCallId, result })),
    }
  })
}

/**
 * A user message carrying every image from a batch of tool results, for
 * providers that can only put a string in a tool output. Returns null when
 * there is nothing to send, so no empty message is appended.
 */
export function toolResultImageFollowUp(results: readonly ToolResult[]): UserContent | null {
  const blocks = labelledBlocks(results.flatMap((r) => r.images ?? []))
  if (blocks.length === 0) return null
  return [
    {
      type: 'text',
      text: 'Images returned by the tool call(s) above (this API cannot attach them to the tool result itself):',
    },
    ...blocks,
  ]
}
