import type { Message, TranscriptAttachment } from './thread-types.ts'
import { renderTextBlock } from '@copse/agent/build-text-with-attachments.ts'

/**
 * A stored user prompt keeps its inline pastes and thread references as single
 * U+FFFC placeholders (see `renderer/views/composer-editor.ts`): the transcript
 * draws a chip at each one from the message's positional `paste`/`thread`
 * attachments, while the pasted text itself was expanded into the run payload
 * and never stored.
 *
 * Legacy replays must drop those placeholders because their chips are not being
 * re-attached and a bare U+FFFC would be noise to the model. Main-reviewed
 * canonical prompts are different: U+FFFC is authored data and stays exact.
 * Display-only derivatives such as auto-generated titles still strip it.
 */

/** U+FFFC OBJECT REPLACEMENT CHARACTER — one inline paste chip. */
export const PASTE_PLACEHOLDER = '￼'

export interface ProjectedPromptText {
  content: string
  projectedAttachments?: {
    inline: Array<{ offset: number; attachment: TranscriptAttachment }>
    trailing: TranscriptAttachment[]
  }
}

/** A stored prompt's own words, with paste placeholders (and the gaps they leave) removed. */
export function stripPastePlaceholders(content: string): string {
  if (!content.includes(PASTE_PLACEHOLDER)) return content.trim()
  return content
    .split(PASTE_PLACEHOLDER)
    .join('')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
}

/**
 * Text safe to replay into inference. Main's canonical representation marker
 * means the message stores exact reviewed provider bytes, where U+FFFC and
 * every whitespace byte are authored content. Projection remains a compatibility
 * signal for protected messages written before that message-level marker.
 * Messages without either provenance signal still need legacy placeholder cleanup.
 */
export function replayPromptText(
  content: string,
  attachments: readonly Pick<TranscriptAttachment, 'projection'>[] | undefined,
  promptRepresentation: Message['promptRepresentation'],
): string {
  return promptRepresentation === 'canonical-provider' ||
    attachments?.some((attachment) => attachment.projection !== undefined)
    ? content
    : stripPastePlaceholders(content)
}

/**
 * Rebuild the compact transcript projection of a Main-reviewed provider prompt.
 *
 * Main stores the exact reviewed bytes for replay and marks only attachment
 * tokens it reconstructed from the optimistic display. The renderer may turn
 * those authenticated tokens back into U+FFFC chip positions for display, but
 * must never infer projections from arbitrary prompt text on its own.
 */
export function projectPromptTextForDisplay(
  content: string,
  attachments: readonly TranscriptAttachment[] | undefined,
  promptRepresentation: Message['promptRepresentation'],
): ProjectedPromptText {
  if (promptRepresentation !== 'canonical-provider' || attachments === undefined) {
    return { content }
  }

  const candidates = attachments.flatMap((attachment, attachmentIndex) => {
    const token =
      attachment.projection === 'canonical-block' && attachment.content !== undefined
        ? renderTextBlock(
            attachment.kind === 'shell' ? `Shell: ${attachment.label}` : attachment.label,
            attachment.content,
          )
        : attachment.projection === 'canonical-thread-label' && attachment.kind === 'thread'
          ? `@${attachment.label}`
          : null
    if (token === null) return []
    const start = content.indexOf(token)
    if (start < 0 || content.indexOf(token, start + 1) >= 0) return []
    return [{ attachment, attachmentIndex, start, end: start + token.length }]
  })
  const matches = candidates
    .filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other !== candidate && candidate.start < other.end && other.start < candidate.end,
        ),
    )
    .sort((left, right) => left.start - right.start)

  const operations: typeof matches = []
  let previousOperationEnd = 0
  for (const match of matches) {
    if (match.attachment.placement === 'inline') {
      operations.push(match)
      previousOperationEnd = match.end
      continue
    }
    const start =
      match.start >= 2 &&
      match.start - 2 >= previousOperationEnd &&
      content.slice(match.start - 2, match.start) === '\n\n'
        ? match.start - 2
        : match.start
    const end =
      start === match.start && content.slice(match.end, match.end + 2) === '\n\n'
        ? match.end + 2
        : match.end
    operations.push({ ...match, start, end })
    previousOperationEnd = end
  }
  let cursor = 0
  let projected = ''
  const inline: Array<{ offset: number; attachment: TranscriptAttachment }> = []
  for (const operation of operations) {
    projected += content.slice(cursor, operation.start)
    if (operation.attachment.placement === 'inline') {
      inline.push({ offset: projected.length, attachment: operation.attachment })
    }
    cursor = operation.end
  }
  projected += content.slice(cursor)
  const inlineIndices = new Set(
    matches
      .filter((match) => match.attachment.placement === 'inline')
      .map((match) => match.attachmentIndex),
  )
  return {
    content: projected,
    projectedAttachments: {
      inline,
      trailing: attachments.filter((_attachment, index) => !inlineIndices.has(index)),
    },
  }
}
