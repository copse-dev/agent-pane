export interface FileAttachment {
  path: string
  content: string
  /** Absolute path of the full content in the attachment spill store, if saved. */
  savedPath?: string
}

export interface TextBlockAttachment {
  label: string
  content: string
  /** Absolute path of the full content in the attachment spill store, if saved. */
  savedPath?: string
}

/** Minimum pasted plain-text length to treat as an attachment instead of inline input. */
export const TEXT_BLOCK_MIN_CHARS = 200

/**
 * Per-attachment character ceiling for inlined content.
 *
 * Inlined attachments are the one prompt input with no other guard: unlike
 * `read_file` (capped per run) and conversation history (trimmed by
 * `trimMessagesInPlace`), a large attachment lands verbatim in the latest user
 * message, which trimming never drops or shrinks. Left unbounded, one big paste
 * or dropped file overflows the model's context window and the request is
 * rejected outright. This ceiling keeps a head+tail preview instead; the omitted
 * middle is summarised in a marker that points the agent at `read_file`/`explore`
 * for the full content.
 *
 * Sized a little above the `read_file` ceiling (12k) since attachments are an
 * intentional user action, while still leaving room for the rest of the prompt.
 */
export const ATTACHMENT_MAX_CHARS = 16_000

/** Fraction of the budget kept from the head; the remainder is kept from the tail. */
const HEAD_FRACTION = 0.7

export function isTextBlockAttachment(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return trimmed.includes('\n') || trimmed.length >= TEXT_BLOCK_MIN_CHARS
}

export function textBlockLabel(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? 'Pasted text'
  return firstLine.length > 48 ? `${firstLine.slice(0, 45)}…` : firstLine
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++
  return n
}

/** Drop a trailing partial line so the head ends on a clean line boundary. */
function trimToLastLine(s: string): string {
  const idx = s.lastIndexOf('\n')
  return idx > 0 ? s.slice(0, idx) : s
}

/** Drop a leading partial line so the tail starts on a clean line boundary. */
function trimToFirstLine(s: string): string {
  const idx = s.indexOf('\n')
  return idx >= 0 && idx < s.length - 1 ? s.slice(idx + 1) : s
}

/**
 * Keep the first and last portions of an oversized attachment, replacing the
 * middle with a marker that records what was dropped and how to recover it.
 * Returns the content unchanged when it already fits.
 */
export function truncateAttachmentContent(
  content: string,
  maxChars: number = ATTACHMENT_MAX_CHARS,
  savedPath?: string,
): string {
  if (content.length <= maxChars) return content

  const headBudget = Math.floor(maxChars * HEAD_FRACTION)
  const tailBudget = maxChars - headBudget
  const head = trimToLastLine(content.slice(0, headBudget))
  const tail = trimToFirstLine(content.slice(content.length - tailBudget))

  const omittedChars = content.length - head.length - tail.length
  const omittedLines = Math.max(
    0,
    countNewlines(content) - countNewlines(head) - countNewlines(tail),
  )

  // When the full content was spilled to the attachment store, point the agent
  // at the exact path; otherwise fall back to asking the user to save it.
  const recovery = savedPath
    ? `The full attachment is saved at ${savedPath} — read it with read_file or explore to see the omitted content.`
    : `If you need the omitted content, ask the user to save the full file into the workspace so you can read it with read_file or explore.`

  const marker =
    `\n\n… [Copse trimmed ${omittedChars.toLocaleString()} characters` +
    `${omittedLines > 0 ? ` (~${omittedLines.toLocaleString()} lines)` : ''}` +
    ` from the middle of this attachment to keep the request within the model's context window. ` +
    `Only the first and last portions are shown. ${recovery}] …\n\n`

  return head + marker + tail
}

export interface BuildTextOptions {
  /** Per-attachment character ceiling; defaults to {@link ATTACHMENT_MAX_CHARS}. */
  maxCharsPerAttachment?: number
}

export function buildTextWithAttachments(
  text: string,
  files: FileAttachment[],
  textBlocks: TextBlockAttachment[] = [],
  options: BuildTextOptions = {},
): string {
  const cap = options.maxCharsPerAttachment ?? ATTACHMENT_MAX_CHARS
  const blocks = [
    ...files.map(
      (f) => `\`\`\`\n// ${f.path}\n${truncateAttachmentContent(f.content, cap, f.savedPath)}\n\`\`\``,
    ),
    ...textBlocks.map(
      (b) =>
        `\`\`\`\n// ${b.label}\n${truncateAttachmentContent(b.content, cap, b.savedPath)}\n\`\`\``,
    ),
  ]
  return [text, ...blocks].filter(Boolean).join('\n\n')
}
