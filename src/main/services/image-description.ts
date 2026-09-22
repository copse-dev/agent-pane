import type { LLMMessage, LLMProvider, ModelUsage } from '@shared/types'
import { buildProvider } from './providers/provider-selection.ts'
import { completeMessagesWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'

const DESCRIPTION_TIMEOUT_MS = 90_000
const MAX_DESCRIPTION_IMAGES = 5
const MAX_DESCRIPTION_IMAGE_DATA_CHARS = 24 * 1024 * 1024

export interface ImageDescriptionRequest {
  projectId: string
  threadId: string
  model: string
  userPrompt: string
  images: string[]
}

function descriptionInstruction(imageCount: number): string {
  return [
    `Describe the attached ${imageCount === 1 ? 'image' : `${String(imageCount)} images`} for another AI model that cannot view images.`,
    'Produce a faithful, standalone description. Focus on visible details, including exact text, layout, spacing, alignment, state, colours, and spatial relationships when present.',
    'Do not solve the user’s task or claim certainty about details you cannot see. Clearly label uncertainty.',
  ].join('\n')
}

export async function describeImagesWithProvider(
  provider: LLMProvider,
  request: Pick<ImageDescriptionRequest, 'userPrompt' | 'images'>,
  timeoutMs = DESCRIPTION_TIMEOUT_MS,
): Promise<{ text: string; usage: ModelUsage }> {
  // Keep the original composer prompt on the request so the caller can append
  // the description to it after this handoff. It is intentionally not included
  // in the vision-model prompt: composer instructions can steer the describer
  // away from faithfully reporting what is visible.
  const { images } = request
  if (images.length === 0 || images.length > MAX_DESCRIPTION_IMAGES) {
    throw new Error(`Image description accepts 1–${String(MAX_DESCRIPTION_IMAGES)} images.`)
  }
  const totalChars = images.reduce((sum, image) => sum + image.length, 0)
  if (totalChars > MAX_DESCRIPTION_IMAGE_DATA_CHARS) {
    throw new Error('Images are too large to describe in one request.')
  }
  const content: Extract<LLMMessage, { role: 'user' }>['content'] = [
    ...images.map((dataUrl) => ({ type: 'image' as const, dataUrl })),
    { type: 'text', text: descriptionInstruction(images.length) },
  ]
  const result = await completeMessagesWithUsage(provider, [{ role: 'user', content }], timeoutMs)
  const text = result.text.trim()
  if (!text) throw new Error('The image-capable model returned an empty description.')
  return { text, usage: result.usage }
}

/** Create a disclosed text handoff from a positively image-capable model. */
export async function describeImagesForHandoff(
  request: ImageDescriptionRequest,
): Promise<{ text: string }> {
  const provider = await buildProvider(request.model, `image-description:${request.threadId}`)
  const result = await describeImagesWithProvider(provider, request)
  recordUsageEvent({
    model: request.model,
    source: 'small-tasks',
    projectId: request.projectId,
    threadId: request.threadId,
    ...result.usage,
  })
  return { text: result.text }
}
