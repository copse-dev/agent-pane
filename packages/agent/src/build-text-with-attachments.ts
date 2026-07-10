export interface FileAttachment {
  path: string
  content: string
}

export interface TextBlockAttachment {
  label: string
  content: string
}

/**
 * A reference to a past conversation (issue #644). Unlike files/text blocks,
 * nothing is inlined — the agent is pointed at the thread's on-disk directory and
 * explores it with the read tools, so there is no size cap to apply.
 */
export interface ThreadRefAttachment {
  title: string
  /** Human-readable date shown to the agent (e.g. "3 days ago" or "2026-06-30"). */
  date: string
  /** Absolute path to the thread's `events.jsonl` spine. */
  spinePath: string
}

/** Minimum pasted plain-text length to treat as an attachment instead of inline input. */
export const TEXT_BLOCK_MIN_CHARS = 200

/** Minimum pasted line count to treat as an attachment instead of inline input. */
export const TEXT_BLOCK_MIN_LINES = 10

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

/**
 * Whether a paste is big enough to fold into an attachment chip. Short pastes —
 * even multi-line ones — stay inline in the composer where the user can read and
 * edit them; only genuinely large blocks (long, or many lines) become chips.
 */
export function isTextBlockAttachment(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length >= TEXT_BLOCK_MIN_CHARS) return true
  return countNewlines(trimmed) + 1 >= TEXT_BLOCK_MIN_LINES
}

/**
 * Chip label for a pasted block: the first non-blank line, so a paste that
 * starts with blank lines still gets a readable preview instead of an empty chip.
 */
export function textBlockLabel(content: string): string {
  const firstLine =
    content
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? 'Pasted text'
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

  const marker =
    `\n\n… [Copse trimmed ${omittedChars.toLocaleString()} characters` +
    (omittedLines > 0 ? ` (~${omittedLines.toLocaleString()} lines)` : '') +
    ` from the middle of this attachment to keep the request within the model's context window. ` +
    `Only the first and last portions are shown. If you need the omitted content, ask the user ` +
    `to save the full file into the workspace so you can read it with read_file or explore.] …\n\n`

  return head + marker + tail
}

export interface BuildTextOptions {
  /** Per-attachment character ceiling; defaults to {@link ATTACHMENT_MAX_CHARS}. */
  maxCharsPerAttachment?: number
  /** `@`-referenced past conversations to point the agent at (nothing inlined). */
  threadRefs?: ThreadRefAttachment[]
}

// One compact preamble describes the on-disk thread layout so the agent can
// explore any number of referenced threads with the file tools. Emitted once,
// regardless of how many threads are attached.
const THREAD_STEERING_PREAMBLE =
  'The past conversation(s) referenced below are available read-only through your ' +
  'file tools. Each is a directory: `events.jsonl` is the linear history (one JSON ' +
  'line per finalized message, oldest first); message prose is under `messages/*.md`; ' +
  'tool results and images under `blobs/`; nested subagent runs under `subagents/`. ' +
  'Read a file with read_file, grep with search_code, or summarize a whole thread ' +
  'with explore. The paths are absolute; do not try to write to them.'

function buildThreadRefBlock(refs: ThreadRefAttachment[]): string {
  const lines = refs.map((r) => `- "${r.title}" (${r.date}): ${r.spinePath}`)
  return `${THREAD_STEERING_PREAMBLE}\n\nReferenced threads:\n${lines.join('\n')}`
}

/**
 * The fenced block a labelled attachment inlines into the prompt. Shared by the
 * end-of-message attachment path below and the composer's inline paste chips,
 * which expand in place, so both render the one format the agent sees.
 */
export function renderTextBlock(
  label: string,
  content: string,
  maxChars: number = ATTACHMENT_MAX_CHARS,
): string {
  return `\`\`\`\n// ${label}\n${truncateAttachmentContent(content, maxChars)}\n\`\`\``
}

export function buildTextWithAttachments(
  text: string,
  files: FileAttachment[],
  textBlocks: TextBlockAttachment[] = [],
  options: BuildTextOptions = {},
): string {
  const cap = options.maxCharsPerAttachment ?? ATTACHMENT_MAX_CHARS
  const threadRefs = options.threadRefs ?? []
  const blocks = [
    ...files.map((f) => renderTextBlock(f.path, f.content, cap)),
    ...textBlocks.map((b) => renderTextBlock(b.label, b.content, cap)),
    // No truncation path — thread refs inline nothing, so ATTACHMENT_MAX_CHARS
    // never applies here.
    ...(threadRefs.length > 0 ? [buildThreadRefBlock(threadRefs)] : []),
  ]
  return [text, ...blocks].filter(Boolean).join('\n\n')
}
