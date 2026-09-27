/**
 * A stored user prompt keeps its inline pastes and thread references as single
 * U+FFFC placeholders (see `renderer/views/composer-editor.ts`): the transcript
 * draws a chip at each one from the message's positional `paste`/`thread`
 * attachments, while the pasted text itself was expanded into the run payload
 * and never stored.
 *
 * Anything that re-derives a *prompt to send* from a stored message — resending
 * the last message, rebuilding a fork's provider history — must drop those
 * placeholders. Their chips are not being re-attached, and a bare U+FFFC in the
 * prompt is noise the model would have to interpret. The same goes for text
 * derived for display outside the transcript, such as an auto-generated thread
 * title, where a bare U+FFFC renders as a boxed "OBJ" glyph.
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
