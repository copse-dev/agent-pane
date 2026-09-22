import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { showToast } from '../views/toast.ts'
import type { AnnotationExport } from './annotation-layer.ts'

/**
 * Hand an annotation to the composer: the flattened PNG when the surface
 * could be captured, and always the SVG so the agent has the exact geometry
 * as text. Returns false when no thread is open to receive it.
 */
export function attachAnnotation(payload: AnnotationExport, subject: string): boolean {
  const handlers = getPromptAttachmentHandlers()
  if (!handlers) {
    showToast('Open a thread before sending an annotation.', { variant: 'error' })
    return false
  }
  if (payload.png) handlers.attachImage(payload.png, 'image/png')
  handlers.attachTextBlock(payload.svg, `Annotation over ${subject} (SVG)`)
  handlers.focusComposer?.()
  showToast(
    payload.png
      ? 'Added annotated screenshot to the thread.'
      : 'Added annotation to the thread (capture unavailable).',
    { durationMs: 2_000 },
  )
  return true
}
