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
const submissionSchema = z.object({ text: z.string().max(1_000_000) }).strict()
const lockedSessions = new WeakSet<Session>()

interface PendingReview {
  window: BrowserWindow
  seed: ProtectedPromptSeed
  resolve: (submission: ProtectedPromptSubmission | null) => void
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
  const ranges = expanded.tokens.map((token) => uniqueTokenRange(modelText, token))
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
  let inlineIndex = 0
  return rendererFields.map((attachment) => {
    if (attachment.placement !== 'inline') return attachment
    const range = ranges[inlineIndex]
    const ambiguous = range === null || range === undefined || overlapping.has(inlineIndex)
    inlineIndex++
    if (ambiguous) return attachment
    const projection =
      attachment.kind === 'paste'
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

export class ProtectedPromptReviewService {
  private readonly pending = new Map<number, PendingReview>()
  private readonly pendingByParent = new Map<number, PendingReview>()

  constructor(ipcMain: IpcMain) {
    ipcMain.handle('protected-prompt:submit', (event, submission: unknown) => {
      const parsed = submissionSchema.parse(submission)
      this.settle(event, parsed)
    })
    ipcMain.handle('protected-prompt:cancel', (event) => {
      this.settle(event, null)
    })
  }

  async review(
    parent: BrowserWindow,
    input: ProtectedPromptReviewInput,
  ): Promise<ProtectedPromptSubmission | null> {
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

    const result = new Promise<ProtectedPromptSubmission | null>((resolve) => {
      const pending = { window, seed, resolve }
      const childId = window.webContents.id
      const parentId = parent.webContents.id
      this.pending.set(childId, pending)
      this.pendingByParent.set(parentId, pending)
      window.once('closed', () => {
        if (this.pending.get(childId) === pending) {
          this.pending.delete(childId)
          this.pendingByParent.delete(parentId)
          resolve(null)
        }
      })
      window.once('ready-to-show', () => {
        if (!window.isDestroyed()) window.show()
      })
      window.webContents.once('did-finish-load', () => {
        if (!window.isDestroyed()) window.webContents.send('protected-prompt:seed', seed)
      })
    })
    const cancel = (): void => {
      if (!window.isDestroyed()) window.destroy()
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (input.signal?.aborted) cancel()
      else await window.loadFile(join(__dirname, '../renderer/protected-prompt.html'))
      return await result
    } catch (error) {
      cancel()
      if (input.signal?.aborted) return null
      throw error
    } finally {
      input.signal?.removeEventListener('abort', cancel)
    }
  }

  private settle(event: IpcMainInvokeEvent, submission: ProtectedPromptSubmission | null): void {
    const pending = this.pending.get(event.sender.id)
    if (!pending || pending.window.webContents !== event.sender) {
      throw new Error('Protected prompt response came from an untrusted window')
    }
    this.pending.delete(event.sender.id)
    const parentId = pending.window.getParentWindow()?.webContents.id
    if (parentId !== undefined) this.pendingByParent.delete(parentId)
    pending.resolve(submission)
    if (!pending.window.isDestroyed()) pending.window.destroy()
  }
}
