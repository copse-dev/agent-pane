import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { showToast } from '../views/toast.ts'
import { describeMarks, type AnnotationExport } from './annotation-layer.ts'

export interface AnnotationContext {
  /** What was annotated: page title, artefact title. */
  subject: string
  url?: string | null
  /** Extracted text of the page beneath the marks, when the host can read it. */
  pageText?: string | null
}

/** The text block that travels with the annotated screenshot. */
export function annotationTextBlock(payload: AnnotationExport, context: AnnotationContext): string {
  const lines = [`Annotation over ${context.subject}`]
  if (context.url) lines.push(`URL: ${context.url}`)
  lines.push(
    `Screenshot size: ${String(payload.width)}×${String(payload.height)} CSS px; mark positions below use that space, origin top-left.`,
    '',
    'Marks:',
    ...describeMarks(payload.marks),
  )
  if (context.pageText?.trim()) {
    lines.push('', 'Page text:', context.pageText.trim())
  }
  return lines.join('\n')
}

/**
 * Hand an annotation to the composer as two attachments a model can use
 * together: the screenshot with the marks flattened on (or the marks alone
 * when the surface could not be captured) and one text block naming the
 * page, listing each mark's tool and bounding box, and carrying the page
 * text. The raw SVG stays in `payload` for callers that want geometry.
 * Returns false when no thread is open to receive it.
 */
export function attachAnnotation(payload: AnnotationExport, context: AnnotationContext): boolean {
  const handlers = getPromptAttachmentHandlers()
  if (!handlers) {
    showToast('Open a thread before sending an annotation.', { variant: 'error' })
    return false
  }
  if (payload.png) handlers.attachImage(payload.png, 'image/png')
  handlers.attachTextBlock(annotationTextBlock(payload, context), `Annotation: ${context.subject}`)
  handlers.focusComposer?.()
  showToast(
    payload.png
      ? 'Added annotated screenshot to the thread.'
      : 'Added annotation to the thread (capture unavailable).',
    { durationMs: 2_000 },
  )
  return true
}
