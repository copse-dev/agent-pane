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
