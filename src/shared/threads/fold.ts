import type { ModelParameters } from '@copse/llm/model-parameters.ts'
import type {
  Message,
  ModelUsage,
  QueuedMessageOrigin,
  SubagentMessage,
  SubagentSession,
  Thread,
  ThreadReview,
  ToolCall,
  TranscriptAttachment,
  TurnOutcome,
} from '@shared/types'
import { hookCardFromSpineLine } from '../hooks/hook-card.ts'
import {
  type ContentRef,
  type HashFn,
  type ImageRef,
  type SpineEntry,
  type SpineMessageLine,
  type SpineSubagentRef,
  type SpineToolCall,
  type ThreadMeta,
  SPINE_SCHEMA_VERSION,
  parseSpine,
  serializeSpine,
} from './spine-schema.ts'
import { parseOkfMessage, serializeOkfMessage } from './okf-message.ts'

/**
 * Pure fold/explode between an in-memory {@link Thread} and its on-disk shape
 * (issue #644). `explode*` turns a message into the files to write plus its spine
 * line; `fold*` reconstructs it, verifying content hashes. The round-trip is 1:1
 * — `foldThread(meta, explodeThread(messages))` deep-equals the original.
 */

/** A file to persist, path relative to the directory its spine (`events.jsonl`) lives in. */
export interface FileToWrite {
  ref: string
  contents: string
}

/** Structural superset of {@link Message} and {@link SubagentMessage}. */
interface MessageLike {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  toolCalls: ToolCall[]
  createdAt?: number
  reasoning?: string
  images?: string[]
  commandSummary?: string
  toolSummary?: string
  attachments?: TranscriptAttachment[]
  model?: string
  requestedModel?: string
  parameters?: ModelParameters
  turnOutcome?: TurnOutcome
  review?: ThreadReview
  origin?: QueuedMessageOrigin
  editedByUser?: boolean
  startingCommit?: string
  dirty?: boolean
}

export interface ExplodedMessage {
  line: SpineMessageLine
  /** Files relative to the thread directory (includes nested `subagents/**`). */
  files: FileToWrite[]
}

const EVENTS_FILE = 'events.jsonl'

function contentRef(ref: string, content: string, hash: HashFn): ContentRef {
  return { ref, sha256: hash(content) }
}

function explodeToolCall(
  tc: ToolCall,
  hash: HashFn,
): { spine: SpineToolCall; files: FileToWrite[] } {
  const files: FileToWrite[] = []

  let result: ContentRef | null = null
  if (tc.result !== null) {
    const ref = `blobs/${tc.id}.result.txt`
    files.push({ ref, contents: tc.result })
    result = contentRef(ref, tc.result, hash)
  }

  const spine: SpineToolCall = {
    id: tc.id,
    name: tc.name,
    args: tc.args,
    status: tc.status === 'error' ? 'error' : 'done',
    result,
    ...(tc.editStats !== undefined ? { editStats: tc.editStats } : {}),
    // ACP display metadata (issue #264): `kind` drives the same grouping/labels
    // as built-in tools; `resultFormat` keeps agent-authored Markdown rendering
    // through the Markdown pipeline after a reload instead of a raw <pre>.
    ...(tc.kind !== undefined ? { kind: tc.kind } : {}),
    ...(tc.resultFormat !== undefined ? { resultFormat: tc.resultFormat } : {}),
  }

  if (tc.subagent) {
    const prefix = `subagents/${tc.subagent.id}/`
    const subLines: SpineMessageLine[] = []
    for (const msg of tc.subagent.messages) {
      const exploded = explodeOne(msg, hash)
      subLines.push(exploded.line)
      for (const f of exploded.files) files.push({ ref: prefix + f.ref, contents: f.contents })
    }
    files.push({ ref: prefix + EVENTS_FILE, contents: serializeSpine(subLines) })
    spine.subagent = {
      ref: prefix,
      kind: tc.subagent.kind,
      status: tc.subagent.status,
      prompt: tc.subagent.prompt,
      summary: tc.subagent.summary,
      ...(tc.subagent.usage !== undefined ? { usage: tc.subagent.usage } : {}),
      ...(tc.subagent.model !== undefined ? { model: tc.subagent.model } : {}),
      ...(tc.subagent.localFallback !== undefined
        ? { localFallback: tc.subagent.localFallback }
        : {}),
    }
  }

  return { spine, files }
}

function explodeOne(msg: MessageLike, hash: HashFn): ExplodedMessage {
  const files: FileToWrite[] = []
  const createdAt = msg.createdAt

  const contentPath = `messages/${msg.id}.md`
  files.push({
    contents: serializeOkfMessage(
      { type: 'Message', role: msg.role, id: msg.id, createdAt: createdAt ?? 0 },
      msg.content,
    ),
    ref: contentPath,
  })

  const line: SpineMessageLine = {
    v: SPINE_SCHEMA_VERSION,
    type: 'message',
    id: msg.id,
    role: msg.role,
    content: contentRef(contentPath, msg.content, hash),
    toolCalls: [],
    ...(createdAt !== undefined ? { createdAt } : {}),
  }

  if (msg.reasoning !== undefined) {
    const ref = `messages/${msg.id}.reasoning.md`
    files.push({
      contents: serializeOkfMessage(
        { type: 'Reasoning', role: msg.role, id: msg.id, createdAt: createdAt ?? 0 },
        msg.reasoning,
      ),
      ref,
    })
    line.reasoning = contentRef(ref, msg.reasoning, hash)
  }

  if (msg.images !== undefined && msg.images.length > 0) {
    const images: ImageRef[] = []
    msg.images.forEach((dataUrl, i) => {
      const ref = `blobs/${msg.id}-img-${String(i)}.dataurl`
      files.push({ ref, contents: dataUrl })
      images.push({ ref, sha256: hash(dataUrl) })
    })
    line.images = images
  }

  if (msg.commandSummary !== undefined) line.commandSummary = msg.commandSummary
  if (msg.toolSummary !== undefined) line.toolSummary = msg.toolSummary
  if (msg.attachments !== undefined && msg.attachments.length > 0) {
    line.attachments = msg.attachments.map((attachment, i) => {
      const { content, ...metadata } = attachment
      if (content === undefined) return metadata
      const ref = `blobs/${msg.id}-attachment-${String(i)}.txt`
      files.push({ ref, contents: content })
      return { ...metadata, content: contentRef(ref, content, hash) }
    })
  }
  if (msg.model !== undefined) line.model = msg.model
  if (msg.requestedModel !== undefined) line.requestedModel = msg.requestedModel
  if (msg.parameters !== undefined) line.parameters = msg.parameters
  if (msg.turnOutcome !== undefined) line.turnOutcome = msg.turnOutcome
  if (msg.review !== undefined) line.review = msg.review
  if (msg.origin !== undefined) line.origin = msg.origin
  if (msg.editedByUser !== undefined) line.editedByUser = msg.editedByUser
  if (msg.startingCommit !== undefined) line.startingCommit = msg.startingCommit
  if (msg.dirty !== undefined) line.dirty = msg.dirty

  for (const tc of msg.toolCalls) {
    const { spine, files: tcFiles } = explodeToolCall(tc, hash)
    line.toolCalls.push(spine)
    for (const f of tcFiles) files.push(f)
  }

  return { line, files }
}

/** Explode a single finalized message into its spine line + files to write. */
export function explodeMessage(message: Message, hash: HashFn): ExplodedMessage {
  return explodeOne(message, hash)
}

/** Explode a whole message list: the top-level spine plus every file. */
export function explodeThread(
  messages: Message[],
  hash: HashFn,
): { spine: SpineMessageLine[]; files: FileToWrite[] } {
  const spine: SpineMessageLine[] = []
  const files: FileToWrite[] = []
  for (const message of messages) {
    const { line, files: msgFiles } = explodeOne(message, hash)
    spine.push(line)
    for (const f of msgFiles) files.push(f)
  }
  return { spine, files }
}

/** Reads the logical contents of a ref (path relative to the thread directory). */
export type RefResolver = (ref: string) => string

/**
 * Every thread-relative ref one spine line will make the fold resolve, split by
 * kind. `files` are read directly; each entry of `subagentDirs` is a directory
 * prefix whose own `events.jsonl` must be read and walked in turn (the fold
 * recurses into it through a prefixing resolver — see {@link foldSubagent}).
 *
 * This exists so a caller can prefetch a thread's files asynchronously and then
 * fold from memory, keeping {@link foldThread} synchronous and fs-free. It is
 * deliberately next to {@link foldOne}: the two enumerate the same refs, and a
 * ref added to one without the other would make the fold throw
 * `Missing thread file` at load. The test "refsOfLine enumerates exactly the
 * refs the fold resolves" pins that pairing by recording what the fold actually
 * asks its resolver for.
 */
export function refsOfLine(line: SpineMessageLine): {
  files: string[]
  subagentDirs: string[]
} {
  const files: string[] = [line.content.ref]
  const subagentDirs: string[] = []
  if (line.reasoning) files.push(line.reasoning.ref)
  if (line.images) for (const img of line.images) files.push(img.ref)
  if (line.attachments) {
    for (const attachment of line.attachments) {
      if (attachment.content) files.push(attachment.content.ref)
    }
  }
  for (const tc of line.toolCalls) {
    if (tc.result !== null) files.push(tc.result.ref)
    if (tc.subagent) subagentDirs.push(tc.subagent.ref)
  }
  return { files, subagentDirs }
}

function verify(ref: ContentRef, body: string, hash: HashFn | undefined): void {
  if (hash && hash(body) !== ref.sha256) {
    throw new Error(`Thread content hash mismatch for ${ref.ref}`)
  }
}

function readBody(ref: string, resolve: RefResolver): string {
  const raw = resolve(ref)
  const parsed = parseOkfMessage(raw)
  if (!parsed) throw new Error(`Malformed OKF message file: ${ref}`)
  return parsed.body
}

function foldToolCall(
  spine: SpineToolCall,
  resolve: RefResolver,
  hash: HashFn | undefined,
): ToolCall {
  let result: string | null = null
  if (spine.result !== null) {
    result = resolve(spine.result.ref)
    verify(spine.result, result, hash)
  }

  const tc: ToolCall = {
    id: spine.id,
    name: spine.name,
    args: spine.args,
    status: spine.status,
    result,
    ...(spine.editStats !== undefined ? { editStats: spine.editStats } : {}),
    ...(spine.kind !== undefined ? { kind: spine.kind } : {}),
    ...(spine.resultFormat !== undefined ? { resultFormat: spine.resultFormat } : {}),
  }

  if (spine.subagent) {
    tc.subagent = foldSubagent(spine.subagent, resolve, hash)
  }
  return tc
}

function foldSubagent(
  ref: SpineSubagentRef,
  resolve: RefResolver,
  hash: HashFn | undefined,
): SubagentSession {
  const nested: RefResolver = (r) => resolve(ref.ref + r)
  const lines = parseSpine(nested(EVENTS_FILE))
  const messages: SubagentMessage[] = lines.map((line) => {
    const folded = foldOne(line, nested, hash)
    const msg: SubagentMessage = {
      id: folded.id,
      role: folded.role === 'error' ? 'assistant' : folded.role,
      content: folded.content,
      toolCalls: folded.toolCalls,
      ...(folded.createdAt !== undefined ? { createdAt: folded.createdAt } : {}),
    }
    return msg
  })

  const usage: ModelUsage | undefined = ref.usage
  return {
    id: ref.ref.replace(/^subagents\//, '').replace(/\/$/, ''),
    kind: ref.kind,
    status: ref.status,
    prompt: ref.prompt,
    summary: ref.summary,
    messages,
    ...(usage !== undefined ? { usage } : {}),
    ...(ref.model !== undefined ? { model: ref.model } : {}),
    ...(ref.localFallback !== undefined ? { localFallback: ref.localFallback } : {}),
  }
}

function foldOne(
  line: SpineMessageLine,
  resolve: RefResolver,
  hash: HashFn | undefined,
): MessageLike {
  const content = readBody(line.content.ref, resolve)
  verify(line.content, content, hash)

  const msg: MessageLike = {
    id: line.id,
    role: line.role,
    content,
    toolCalls: line.toolCalls.map((tc) => foldToolCall(tc, resolve, hash)),
    ...(line.createdAt !== undefined ? { createdAt: line.createdAt } : {}),
  }

  if (line.reasoning) {
    const reasoning = readBody(line.reasoning.ref, resolve)
    verify(line.reasoning, reasoning, hash)
    msg.reasoning = reasoning
  }

  if (line.images) {
    msg.images = line.images.map((img) => {
      const dataUrl = resolve(img.ref)
      if (hash && hash(dataUrl) !== img.sha256) {
        throw new Error(`Thread image hash mismatch for ${img.ref}`)
      }
      return dataUrl
    })
  }

  if (line.commandSummary !== undefined) msg.commandSummary = line.commandSummary
  if (line.toolSummary !== undefined) msg.toolSummary = line.toolSummary
  if (line.attachments !== undefined) {
    msg.attachments = line.attachments.map((attachment) => {
      const { content, ...metadata } = attachment
      if (!content) return metadata
      const snapshot = resolve(content.ref)
      verify(content, snapshot, hash)
      return { ...metadata, content: snapshot }
    })
  }
  if (line.model !== undefined) msg.model = line.model
  if (line.requestedModel !== undefined) msg.requestedModel = line.requestedModel
  if (line.parameters !== undefined) msg.parameters = line.parameters
  if (line.turnOutcome !== undefined) msg.turnOutcome = line.turnOutcome
  if (line.review !== undefined) msg.review = line.review
  if (line.origin !== undefined) msg.origin = line.origin
  if (line.editedByUser !== undefined) msg.editedByUser = line.editedByUser
  if (line.startingCommit !== undefined) msg.startingCommit = line.startingCommit
  if (line.dirty !== undefined) msg.dirty = line.dirty
  return msg
}

/** Fold one top-level spine line back into a {@link Message}. */
export function foldMessage(
  line: SpineMessageLine,
  resolve: RefResolver,
  opts: { hash?: HashFn } = {},
): Message {
  const m = foldOne(line, resolve, opts.hash)
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    createdAt: m.createdAt ?? 0,
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.images !== undefined ? { images: m.images } : {}),
    ...(m.commandSummary !== undefined ? { commandSummary: m.commandSummary } : {}),
    ...(m.toolSummary !== undefined ? { toolSummary: m.toolSummary } : {}),
    ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
    ...(m.model !== undefined ? { model: m.model } : {}),
    ...(m.requestedModel !== undefined ? { requestedModel: m.requestedModel } : {}),
    ...(m.parameters !== undefined ? { parameters: m.parameters } : {}),
    ...(m.turnOutcome !== undefined ? { turnOutcome: m.turnOutcome } : {}),
    ...(m.review !== undefined ? { review: m.review } : {}),
    ...(m.origin !== undefined ? { origin: m.origin } : {}),
    ...(m.editedByUser !== undefined ? { editedByUser: m.editedByUser } : {}),
    ...(m.startingCommit !== undefined ? { startingCommit: m.startingCommit } : {}),
    ...(m.dirty !== undefined ? { dirty: m.dirty } : {}),
  }
}

/**
 * Attach the thread's always-on `hook_run` spine records to the messages they
 * fired within, as display-only {@link Message.hookCards} (decisions 6, 10 &
 * 17). Hook runs are appended to `events.jsonl` mid-turn, so each anchors to the
 * message that precedes it in the spine — the same anchoring
 * {@link rebuildSpinePreservingNonMessageLines} uses to keep them positioned
 * across full rewrites. A run with no preceding message (or one whose anchor
 * message is absent from `messages`) attaches to the first message, so it is
 * never silently dropped.
 *
 * Pure: takes the parsed spine entries (message + hook_run + unknown lines in
 * file order) and returns messages with `hookCards` populated. Cards are derived
 * here, never persisted via {@link explodeMessage} — the spine `hook_run` lines
 * are the single source of truth (decision 17), so this is the one place they
 * become renderable.
 */
export function attachHookCards(messages: Message[], entries: SpineEntry[]): Message[] {
  const cardsByAnchor = new Map<string | null, ReturnType<typeof hookCardFromSpineLine>[]>()
  let lastMessageId: string | null = null
  for (const entry of entries) {
    if (entry.line?.type === 'message') {
      lastMessageId = entry.line.id
      continue
    }
    if (entry.line?.type !== 'hook_run') continue
    const list = cardsByAnchor.get(lastMessageId)
    const card = hookCardFromSpineLine(entry.line)
    if (list) list.push(card)
    else cardsByAnchor.set(lastMessageId, [card])
  }
  if (cardsByAnchor.size === 0) return messages

  const known = new Set(messages.map((m) => m.id))
  // Cards anchored to no message (before the first message) or to a message that
  // no longer exists fall onto the first message so they stay visible.
  const orphans: ReturnType<typeof hookCardFromSpineLine>[] = [...(cardsByAnchor.get(null) ?? [])]
  for (const [anchor, cards] of cardsByAnchor) {
    if (anchor !== null && !known.has(anchor)) orphans.push(...cards)
  }

  return messages.map((m, index) => {
    const own = cardsByAnchor.get(m.id) ?? []
    const extra = index === 0 ? orphans : []
    const hookCards = [...extra, ...own]
    return hookCards.length > 0 ? { ...m, hookCards } : m
  })
}

/** Reconstruct a full {@link Thread} from its metadata, spine, and file resolver. */
export function foldThread(
  meta: ThreadMeta,
  spine: SpineMessageLine[],
  resolve: RefResolver,
  opts: { hash?: HashFn } = {},
): Thread {
  return { ...meta, messages: spine.map((line) => foldMessage(line, resolve, opts)) }
}
