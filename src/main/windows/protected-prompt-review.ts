import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type Session } from 'electron'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type {
  ProtectedPromptSeed,
  ProtectedPromptSubmission,
  ProtectedPromptContextEntry,
  LLMMessage,
  Message,
  ProtectedHumanTurnDisplay,
  TranscriptAttachment,
  UserContent,
} from '@shared/types'
import { getThreadMeta } from '../services/thread-store.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { THEME_BACKGROUND } from '@shared/theme.ts'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import { renderTextBlock } from '@copse/agent/build-text-with-attachments.ts'

const PROTECTED_PROMPT_PARTITION = 'protected-prompt'
const PROTECTED_PROMPT_INTERRUPTION_TIMEOUT_MS = 1_000
const submissionSchema = z.object({ text: z.string().max(1_000_000) }).strict()
const lockedSessions = new WeakSet<Session>()

export interface ProtectedPromptInterruption {
  kind: 'interrupted'
  text: string
}

export type ProtectedPromptReviewResult =
  | ProtectedPromptSubmission
  | ProtectedPromptInterruption
  | null

export const protectedPromptWasInterrupted: (
  result: ProtectedPromptReviewResult,
) => result is ProtectedPromptInterruption = (result) => result?.kind === 'interrupted'

/** A turn-ending abort gets one bounded chance to retrieve the isolated window's draft. */
export class ProtectedPromptInterruptionDeadline {
  private requested = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly timeoutMs: number

  constructor(timeoutMs = PROTECTED_PROMPT_INTERRUPTION_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  get isRequested(): boolean {
    return this.requested
  }

  request(send: () => void, onTimeout: () => void): void {
    if (this.requested) return
    this.requested = true
    try {
      send()
    } catch {
      onTimeout()
      return
    }
    this.timer = setTimeout(onTimeout, this.timeoutMs)
  }

  finish(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

interface PendingReview {
  childId: number
  parentId: number
  window: BrowserWindow
  seed: ProtectedPromptSeed
  interruption: ProtectedPromptInterruptionDeadline
  resolve: (submission: ProtectedPromptReviewResult) => void
}

export interface ProtectedPromptReviewInput {
  projectId: string
  threadId: string
  content: UserContent
  model?: string
  attachments?: TranscriptAttachment[]
  context: ProtectedPromptContextEntry[]
  kind: 'human' | 'machine'
  signal?: AbortSignal
}

function promptText(content: UserContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const INLINE_ATTACHMENT_PLACEHOLDER = '\uFFFC'

function rendererAttachmentFields(attachment: TranscriptAttachment): TranscriptAttachment {
  return {
    kind: attachment.kind,
    label: attachment.label,
    ...(attachment.placement === undefined ? {} : { placement: attachment.placement }),
    ...(attachment.content === undefined ? {} : { content: attachment.content }),
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
  }
}

function canonicalInlineToken(attachment: TranscriptAttachment): string | null {
  if (attachment.kind === 'thread') return `@${attachment.label}`
  if (attachment.kind !== 'paste' || attachment.content === undefined) return null
  return renderTextBlock(attachment.label, attachment.content)
}

function canonicalTrailingToken(attachment: TranscriptAttachment): string | null {
  if (attachment.content === undefined) return null
  if (attachment.kind === 'shell') {
    return renderTextBlock(`Shell: ${attachment.label}`, attachment.content)
  }
  if (attachment.kind === 'paste' || attachment.kind === 'file') {
    return renderTextBlock(attachment.label, attachment.content)
  }
  return null
}

function expandedInlineDisplay(
  displayContent: string,
  attachments: TranscriptAttachment[],
): { text: string; tokens: string[] } | null {
  const inline = attachments.filter((attachment) => attachment.placement === 'inline')
  const parts = displayContent.split(INLINE_ATTACHMENT_PLACEHOLDER)
  if (parts.length - 1 !== inline.length) return null
  let text = parts[0] ?? ''
  const tokens: string[] = []
  for (let index = 0; index < inline.length; index++) {
    const attachment = inline[index]
    if (attachment === undefined) return null
    const token = canonicalInlineToken(attachment)
    if (token === null) return null
    tokens.push(token)
    if (attachment.kind === 'paste') {
      if (text !== '' && !text.endsWith('\n')) text += '\n\n'
      else if (text.endsWith('\n') && !text.endsWith('\n\n')) text += '\n'
      text += token
      const rest = parts[index + 1] ?? ''
      if (rest !== '' && !rest.startsWith('\n')) text += '\n\n'
    }
    if (attachment.kind === 'thread') text += token
    text += parts[index + 1] ?? ''
  }
  return { text: text.trim(), tokens }
}

function uniqueTokenRange(text: string, token: string): { start: number; end: number } | null {
  const start = text.indexOf(token)
  if (start < 0 || text.indexOf(token, start + 1) >= 0) return null
  return { start, end: start + token.length }
}

/**
 * Grant display projection only when Main can reconstruct the reviewed prompt
 * from the optimistic placeholder sequence. Renderer-supplied projection is
 * always discarded; ambiguous tokens stay literal.
 */
export function reviewedTranscriptAttachments(
  attachments: TranscriptAttachment[],
  displayContent: string,
  modelContent: UserContent,
): TranscriptAttachment[] {
  const rendererFields = attachments.map(rendererAttachmentFields)
  const expanded = expandedInlineDisplay(displayContent, rendererFields)
  if (expanded === null || expanded.text === '') return rendererFields
  const modelText = promptText(modelContent)
  if (modelText !== expanded.text && !modelText.startsWith(`${expanded.text}\n\n`)) {
    return rendererFields
  }
  // Inline eligibility is established by the exact reviewed prefix above.
  // Uniqueness is then measured over the full provider prompt so a projection
  // cannot suppress a second authored copy. Trailing provenance is granted only
  // when every trailing token reconstructs that full prompt below.
  const trailing = rendererFields.filter((attachment) => attachment.placement !== 'inline')
  const trailingTokens = trailing.map(canonicalTrailingToken)
  const exactTrailingProjection =
    trailingTokens.every((token) => token !== null) &&
    [expanded.text, ...trailingTokens].filter(Boolean).join('\n\n') === modelText
  const tokens = rendererFields.map((attachment) =>
    attachment.placement === 'inline'
      ? canonicalInlineToken(attachment)
      : exactTrailingProjection
        ? canonicalTrailingToken(attachment)
        : null,
  )
  const ranges = tokens.map((token) => (token === null ? null : uniqueTokenRange(modelText, token)))
  const overlapping = new Set<number>()
  for (let left = 0; left < ranges.length; left++) {
    const leftRange = ranges[left]
    if (leftRange === null || leftRange === undefined) continue
    for (let right = left + 1; right < ranges.length; right++) {
      const rightRange = ranges[right]
      if (rightRange === null || rightRange === undefined) continue
      if (leftRange.start < rightRange.end && rightRange.start < leftRange.end) {
        overlapping.add(left)
        overlapping.add(right)
      }
    }
  }
  return rendererFields.map((attachment, index) => {
    const range = ranges[index]
    const ambiguous = range === null || range === undefined || overlapping.has(index)
    if (ambiguous) return attachment
    const projection =
      attachment.kind === 'paste' || attachment.kind === 'file' || attachment.kind === 'shell'
        ? 'canonical-block'
        : attachment.kind === 'thread'
          ? 'canonical-thread-label'
          : undefined
    return projection === undefined ? attachment : { ...attachment, projection }
  })
}

/** True only when isolated review returned the exact text it was seeded with. */
export function protectedPromptSubmissionIsUnchanged(
  content: UserContent,
  submission: ProtectedPromptSubmission,
): boolean {
  return submission.text === promptText(content)
}

function imageCount(content: UserContent): number {
  return typeof content === 'string' ? 0 : content.filter((block) => block.type === 'image').length
}

export function protectedPromptImageDataUrls(content: UserContent): string[] {
  return typeof content === 'string'
    ? []
    : content.filter((block) => block.type === 'image').map((block) => block.dataUrl)
}

/** Replace only text; the protected window cannot add, remove, or substitute image bytes. */
export function withProtectedPromptText(content: UserContent, text: string): UserContent {
  if (typeof content === 'string') return text
  const images = content.filter((block) => block.type === 'image')
  return text ? [{ type: 'text', text }, ...images] : images
}

/** Exact persisted prompt match for accepting a renderer message id as a display-only hint. */
export function protectedPromptMessageMatches(
  message: Pick<Message, 'content' | 'images' | 'attachments'>,
  snapshot: NonNullable<ProtectedHumanTurnDisplay['snapshot']>,
  modelContent: UserContent,
): boolean {
  const images = protectedPromptImageDataUrls(modelContent)
  const persistedImages = message.images ?? []
  const attachments = snapshot.attachments ?? []
  const persistedAttachments = message.attachments ?? []
  return (
    message.content === snapshot.content &&
    persistedImages.length === images.length &&
    persistedImages.every((image, index) => image === images[index]) &&
    persistedAttachments.length === attachments.length &&
    persistedAttachments.every((attachment, index) => {
      const candidate = attachments[index]
      return (
        candidate !== undefined &&
        attachment.kind === candidate.kind &&
        attachment.label === candidate.label &&
        attachment.placement === candidate.placement &&
        attachment.projection === candidate.projection &&
        attachment.content === candidate.content &&
        attachment.path === candidate.path
      )
    })
  )
}

/** Stored inference inputs that must remain exact while the protected window is open. */
export function protectedPromptStoredContext(
  history: LLMMessage[],
  plan: StoredThreadPlan | null,
): ProtectedPromptContextEntry[] {
  return [
    ...(history.length > 0
      ? [{ label: 'Existing model conversation', value: JSON.stringify(history, null, 2) }]
      : []),
    ...(plan ? [{ label: 'Existing thread plan', value: JSON.stringify(plan, null, 2) }] : []),
  ]
}

function lockSessionNetwork(session: Session): void {
  if (lockedSessions.has(session)) return
  lockedSessions.add(session)
  session.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: !request.url.startsWith('file:') })
  })
}

/** Serialize protected windows per parent without coupling unrelated app windows. */
export class ProtectedPromptReviewQueue {
  private readonly tails = new Map<number, Promise<void>>()

  async run<T>(
    parentId: number,
    task: () => Promise<T>,
    abort?: { signal: AbortSignal; result: () => T },
  ): Promise<T> {
    const previous = this.tails.get(parentId) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.tails.set(parentId, tail)
    let released = false
    const releaseSlot = (): void => {
      if (released) return
      released = true
      release()
      void tail.then(() => {
        if (this.tails.get(parentId) === tail) this.tails.delete(parentId)
      })
    }
    const ready = previous.catch(() => undefined)
    if (abort) {
      let onAbort: (() => void) | undefined
      const aborted = new Promise<'aborted'>((resolve) => {
        if (abort.signal.aborted) {
          resolve('aborted')
          return
        }
        onAbort = (): void => {
          resolve('aborted')
        }
        abort.signal.addEventListener('abort', onAbort, { once: true })
      })
      const admitted = await Promise.race([ready.then(() => 'ready' as const), aborted])
      if (onAbort) abort.signal.removeEventListener('abort', onAbort)
      if (admitted === 'aborted' || abort.signal.aborted) {
        releaseSlot()
        return abort.result()
      }
    } else {
      await ready
    }
    try {
      return await task()
    } finally {
      releaseSlot()
    }
  }
}

export class ProtectedPromptReviewService {
  private readonly pending = new Map<number, PendingReview>()
  private readonly pendingByParent = new Map<number, PendingReview>()
  private readonly reviewQueue = new ProtectedPromptReviewQueue()

  constructor(ipcMain: IpcMain) {
    ipcMain.handle('protected-prompt:submit', (event, submission: unknown) => {
      const parsed = submissionSchema.parse(submission)
      const pending = this.trustedPending(event)
      this.finishPending(
        pending,
        pending.interruption.isRequested ? { kind: 'interrupted', text: parsed.text } : parsed,
      )
    })
    ipcMain.handle('protected-prompt:cancel', (event, draft: unknown) => {
      const parsed = submissionSchema.parse(draft)
      const pending = this.trustedPending(event)
      this.finishPending(
        pending,
        pending.interruption.isRequested ? { kind: 'interrupted', text: parsed.text } : null,
      )
    })
    ipcMain.handle('protected-prompt:interrupted', (event, draft: unknown) => {
      const parsed = submissionSchema.parse(draft)
      const pending = this.trustedPending(event)
      if (!pending.interruption.isRequested) {
        throw new Error('Protected prompt draft arrived without an interruption request')
      }
      this.finishPending(pending, { kind: 'interrupted', text: parsed.text })
    })
  }

  async review(
    parent: BrowserWindow,
    input: ProtectedPromptReviewInput,
  ): Promise<ProtectedPromptReviewResult> {
    if (input.signal?.aborted) return null
    return this.reviewQueue.run(
      parent.webContents.id,
      () => this.openReview(parent, input),
      input.signal ? { signal: input.signal, result: () => null } : undefined,
    )
  }

  private async openReview(
    parent: BrowserWindow,
    input: ProtectedPromptReviewInput,
  ): Promise<ProtectedPromptReviewResult> {
    if (input.signal?.aborted) return null
    const existing = this.pendingByParent.get(parent.webContents.id)
    if (existing) {
      existing.window.show()
      existing.window.focus()
      throw new Error('A protected prompt is already awaiting review')
    }

    const meta = await getThreadMeta(input.projectId, input.threadId)
    if (!meta) throw new Error('Cannot send a prompt to an unknown thread')
    const projectRoot = getProjectRoot(input.projectId)
    const seed: ProtectedPromptSeed = {
      projectLabel: projectRoot ? `${basename(projectRoot)} — ${projectRoot}` : input.projectId,
      threadLabel: meta.title ? `${meta.title} — ${input.threadId}` : input.threadId,
      text: promptText(input.content),
      ...(input.model !== undefined ? { model: input.model } : {}),
      imageCount: imageCount(input.content),
      images: protectedPromptImageDataUrls(input.content),
      attachments: input.attachments ?? [],
      context: input.context,
      kind: input.kind,
    }

    if (input.signal?.aborted) return null
    const window = new BrowserWindow({
      parent,
      modal: true,
      show: false,
      width: 720,
      height: 640,
      minWidth: 560,
      minHeight: 500,
      title: 'Protected prompt',
      autoHideMenuBar: true,
      backgroundColor: THEME_BACKGROUND.dark,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        spellcheck: true,
        partition: PROTECTED_PROMPT_PARTITION,
        preload: join(__dirname, '../preload/protected-prompt.js'),
      },
    })
    lockSessionNetwork(window.webContents.session)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })

    const childId = window.webContents.id
    const parentId = parent.webContents.id
    const result = new Promise<ProtectedPromptReviewResult>((resolve) => {
      const pending = {
        childId,
        parentId,
        window,
        seed,
        interruption: new ProtectedPromptInterruptionDeadline(),
        resolve,
      }
      this.pending.set(childId, pending)
      this.pendingByParent.set(parentId, pending)
      window.once('closed', () => {
        if (this.pending.get(childId) === pending) {
          this.finishPending(pending, null, false)
        }
      })
      window.once('ready-to-show', () => {
        if (!window.isDestroyed()) window.show()
      })
      window.webContents.once('did-finish-load', () => {
        if (!window.isDestroyed()) window.webContents.send('protected-prompt:seed', seed)
      })
    })
    const interrupt = (): void => {
      const pending = this.pending.get(childId)
      if (!pending) return
      pending.interruption.request(
        () => {
          if (window.isDestroyed()) throw new Error('Protected prompt window is closed')
          window.webContents.send('protected-prompt:interrupt')
        },
        () => {
          this.finishPending(pending, null)
        },
      )
    }
    input.signal?.addEventListener('abort', interrupt, { once: true })
    try {
      if (input.signal?.aborted) interrupt()
      else await window.loadFile(join(__dirname, '../renderer/protected-prompt.html'))
      return await result
    } catch (error) {
      const pending = this.pending.get(childId)
      if (pending) this.finishPending(pending, null)
      if (input.signal?.aborted) return null
      throw error
    } finally {
      input.signal?.removeEventListener('abort', interrupt)
    }
  }

  private trustedPending(event: IpcMainInvokeEvent): PendingReview {
    const pending = this.pending.get(event.sender.id)
    if (!pending || pending.window.webContents !== event.sender) {
      throw new Error('Protected prompt response came from an untrusted window')
    }
    return pending
  }

  private finishPending(
    pending: PendingReview,
    submission: ProtectedPromptReviewResult,
    destroy = true,
  ): void {
    pending.interruption.finish()
    const { childId, parentId } = pending
    if (this.pending.get(childId) !== pending) return
    this.pending.delete(childId)
    this.pendingByParent.delete(parentId)
    pending.resolve(submission)
    if (destroy && !pending.window.isDestroyed()) pending.window.destroy()
  }
}
