import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { showToast } from '../views/toast.ts'
import type { AnnotationExport } from './annotation-layer.ts'

/**
 * Hand an annotation to the composer as a single image: the captured surface
 * with the marks flattened on top, or the marks alone when the surface could
 * not be captured. Nothing else is attached; the SVG and per-mark boxes stay
 * in `payload` for callers that want geometry. Returns false when no thread
 * is open to receive it.
 */
export function attachAnnotation(payload: AnnotationExport, subject: string): boolean {
  const handlers = getPromptAttachmentHandlers()
  if (!handlers) {
    showToast('Open a thread before sending an annotation.', { variant: 'error' })
    return false
  }
  if (!payload.png) {
    showToast(`Could not render the annotation over ${subject}.`, { variant: 'error' })
    return false
  }
  handlers.attachImage(payload.png, 'image/png')
  handlers.focusComposer?.()
  showToast(
    payload.captured
      ? `Added annotated screenshot of ${subject} to the thread.`
      : `Added annotation to the thread (${subject} could not be captured, marks only).`,
    { durationMs: 2_500 },
  )
  return true
}
