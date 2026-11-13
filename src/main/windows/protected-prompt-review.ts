import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type Session } from 'electron'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type {
  ProtectedPromptSeed,
  ProtectedPromptSubmission,
  ProtectedPromptContextEntry,
  TranscriptAttachment,
  UserContent,
} from '@shared/types'
import { getThreadMeta } from '../services/thread-store.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { THEME_BACKGROUND } from '@shared/theme.ts'

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

/** Exact content match for accepting a renderer message id as a display-only hint. */
export function protectedPromptContentMatches(left: UserContent, right: UserContent): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right
  return (
    left.length === right.length &&
    left.every((block, index) => {
      const candidate = right[index]
      if (!candidate || block.type !== candidate.type) return false
      return block.type === 'text'
        ? candidate.type === 'text' && block.text === candidate.text
        : candidate.type === 'image' && block.dataUrl === candidate.dataUrl
    })
  )
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
    await window.loadFile(join(__dirname, '../renderer/protected-prompt.html'))
    return result
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
