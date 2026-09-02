import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './safe-json.ts'

const FRAME_START = '\u{e200}'
const FRAME_SEPARATOR = '\u{e202}'
const FRAME_END = '\u{e201}'
const VISUALIZE_OPERATOR = 'visualize'
const MAX_OPERATOR_CHARS = 64

const visualizationReferenceSchema = z.looseObject({
  path: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
})

export type InlineVisualizationReference = z.infer<typeof visualizationReferenceSchema>

export interface InlineVisualizationStreamFilter {
  push(text: string): string
  finish(): string
}

function decodeVisualizationReference(payload: string): InlineVisualizationReference | null {
  return safeJsonParse(payload, decodeWithSchema(visualizationReferenceSchema))
}

/**
 * Remove provider content-reference frames from an assistant text stream and
 * report supported `visualize` references as soon as their closing marker
 * arrives. Unknown operators are deliberately stripped as control data rather
 * than leaked into the transcript.
 */
export function createInlineVisualizationStreamFilter(
  onReference: (reference: InlineVisualizationReference) => void,
): InlineVisualizationStreamFilter {
  let pending = ''

  const drain = (final: boolean): string => {
    let visible = ''
    for (;;) {
      const start = pending.indexOf(FRAME_START)
      if (start < 0) {
        if (!final && pending.endsWith(FRAME_START)) {
          visible += pending.slice(0, -FRAME_START.length)
          pending = FRAME_START
        } else {
          visible += pending
          pending = ''
        }
        return visible
      }

      visible += pending.slice(0, start)
      pending = pending.slice(start)
      const separator = pending.indexOf(FRAME_SEPARATOR, FRAME_START.length)
      if (separator < 0) {
        // A lone PUA character in ordinary prose must not hold the rest of a
        // long response hostage. A real operator is short and quickly reaches
        // its separator.
        if (!final && pending.length <= FRAME_START.length + MAX_OPERATOR_CHARS) return visible
        if (final) {
          pending = ''
          return visible
        }
        visible += FRAME_START
        pending = pending.slice(FRAME_START.length)
        continue
      }

      const end = pending.indexOf(FRAME_END, separator + FRAME_SEPARATOR.length)
      if (end < 0) {
        if (!final) return visible
        pending = ''
        return visible
      }

      const operator = pending.slice(FRAME_START.length, separator)
      const payload = pending.slice(separator + FRAME_SEPARATOR.length, end)
      pending = pending.slice(end + FRAME_END.length)
      if (operator === VISUALIZE_OPERATOR) {
        const reference = decodeVisualizationReference(payload)
        if (reference) onReference(reference)
      }
    }
  }

  return {
    push(text: string): string {
      pending += text
      return drain(false)
    },
    finish(): string {
      return drain(true)
    },
  }
}

/** Strip complete and incomplete content-reference frames from stored text. */
export function stripInlineVisualizationReferences(text: string): string {
  const filter = createInlineVisualizationStreamFilter(() => {})
  return filter.push(text) + filter.finish()
}
