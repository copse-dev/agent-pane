import type { Message, TranscriptAttachment } from './thread-types.ts'

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
