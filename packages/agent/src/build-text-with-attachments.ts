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

/**
 * A video the user attached to the chat (issue: screen-recording support).
 *
 * Like {@link ThreadRefAttachment} nothing is inlined — and unlike an image
 * attachment the media deliberately never becomes model content. A screen
 * recording is thousands of near-identical frames; handing even a fraction of
 * them to the model would cost more context than the recording is worth. The
 * agent is pointed at the stored file and pulls the few stills it needs with
 * `video_frames`.
 */
export interface VideoRefAttachment {
  /** Absolute path to the stored copy, inside the thread's blobs directory. */
  path: string
  /** Original file name, for the agent to refer to in prose. */
  name: string
  /** Human-readable size (e.g. `12.4 MB`), so the agent can anticipate cost. */
  size: string
}

/**
 * An archive attached to the chat. Like a video, the bytes never become model
 * content — but unlike a video, the agent's move is to unpack it and then read
 * the result as ordinary files, so what it eventually sees is the contents it
 * chose rather than a summary of them.
 */
export interface ArchiveRefAttachment {
  /** Absolute path to the stored copy, inside the thread's blobs directory. */
  path: string
  /** Original file name, for the agent to refer to in prose. */
  name: string
  /** Human-readable size (e.g. `4.2 MB`). */
  size: string
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
  /** Videos attached to the chat, referenced by path (nothing inlined). */
  videoRefs?: VideoRefAttachment[]
  /** Archives attached to the chat, referenced by path (nothing inlined). */
  archiveRefs?: ArchiveRefAttachment[]
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

// States plainly that the video is *not* in context, because the model would
// otherwise reasonably assume an attachment it can see. Naming the tool and the
// default behaviour here saves a wasted turn spent asking the user what to do.
const VIDEO_STEERING_PREAMBLE =
  'The user attached the video(s) below. The video itself is NOT in your context — ' +
  'only these paths are. Use the `video_frames` tool to read one as still images: it ' +
  'samples the recording and returns only the frames that are visually different from ' +
  'each other, so a whole screen recording usually costs a handful of images. Call it ' +
  'with just the path to survey the whole video, then again with `start`/`end` around ' +
  'a moment you need to see more closely. There is no audio track available.'

function buildVideoRefBlock(refs: VideoRefAttachment[]): string {
  const lines = refs.map((r) => `- "${r.name}" (${r.size}): ${r.path}`)
  return `${VIDEO_STEERING_PREAMBLE}\n\nAttached videos:\n${lines.join('\n')}`
}

// Says the two things a model cannot infer from a path: that the bytes are not
// in context, and that unpacking is a one-shot step after which everything is
// an ordinary file. Without the second half a model tends to treat the tool as
// the only way to see inside and calls it once per entry.
const ARCHIVE_STEERING_PREAMBLE =
  'The user attached the archive(s) below. The archive itself is NOT in your context — ' +
  'only these paths are. If you have a `read_archive` tool, use it to unpack one: it ' +
  "extracts the archive into this conversation's own directory and returns a listing of " +
  'everything inside. After that the contents are ordinary files — read them with ' +
  'read_file, grep them with search_code, or summarize the tree with explore, using the ' +
  'paths under the extraction root it gives you. Unpack once, then work with the files. ' +
  'If no such tool is offered to you, say so and ask how to proceed — do not silently ' +
  'ignore the archive, and do not unpack it yourself with shell commands.'

function buildArchiveRefBlock(refs: ArchiveRefAttachment[]): string {
  const lines = refs.map((r) => `- "${r.name}" (${r.size}): ${r.path}`)
  return `${ARCHIVE_STEERING_PREAMBLE}\n\nAttached archives:\n${lines.join('\n')}`
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
  const videoRefs = options.videoRefs ?? []
  const archiveRefs = options.archiveRefs ?? []
  const blocks = [
    ...files.map((f) => renderTextBlock(f.path, f.content, cap)),
    ...textBlocks.map((b) => renderTextBlock(b.label, b.content, cap)),
    // No truncation path — thread, video and archive refs inline nothing, so
    // ATTACHMENT_MAX_CHARS never applies here.
    ...(threadRefs.length > 0 ? [buildThreadRefBlock(threadRefs)] : []),
    ...(videoRefs.length > 0 ? [buildVideoRefBlock(videoRefs)] : []),
    ...(archiveRefs.length > 0 ? [buildArchiveRefBlock(archiveRefs)] : []),
  ]
  return [text, ...blocks].filter(Boolean).join('\n\n')
}
