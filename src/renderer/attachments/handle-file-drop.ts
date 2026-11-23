import type { ApiClient } from '../../preload/api.d.ts'
import { isVideoFile } from '@shared/video/video-media.ts'
import { isArchiveFile } from '@shared/archive/archive-media.ts'
import type { PromptAttachmentHandlers } from './prompt-attachments.ts'
import type { ActiveThreadOwner } from '../controller/active-thread-owner.ts'
import { expectString } from '@shared/unknown-value.ts'
import {
  imageMimeType,
  isRasterImagePath,
  isUnrenderableImageMime,
  isUnrenderableImagePath,
} from '@shared/fs/image-path.ts'
import { workspaceRelativePath } from '@shared/fs/workspace-path.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { showToast } from '../views/toast.ts'

export const WORKSPACE_PATH_MIME = 'application/x-copse-panel-path'

/** Shown instead of a broken chip for an image the composer cannot render, pasted or dropped. */
export const UNSUPPORTED_IMAGE_MESSAGE =
  "Can't attach this image — its format isn't supported here. Save it as PNG or JPEG and try again."

/**
 * Largest file picked from outside the project that attaches as text, and the
 * most of any picked file the binary check reads.
 *
 * The prompt never carries a whole attachment (`renderTextBlock` keeps a
 * head-and-tail preview of `ATTACHMENT_MAX_CHARS`), but the chip holds the full
 * text in the window and the thread saves all of it with the message, so this
 * bounds what a download can copy into the conversation. A file inside the
 * project is not capped, as before: the main process has already read it whole
 * by the time the renderer sees it, and the agent can open the rest by path.
 */
export const MAX_TEXT_ATTACHMENT_BYTES = 4 * 1024 * 1024

/**
 * Whether decoded file text is really binary: any NUL, or more than one
 * character in ten that did not decode as UTF-8. Latin-1 text with a few
 * accents stays text; a PDF-based design file (.ai) or an executable does not.
 */
function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) return true
  let undecodable = 0
  for (let i = text.indexOf('\uFFFD'); i !== -1; i = text.indexOf('\uFFFD', i + 1)) {
    undecodable += 1
  }
  return undecodable * 10 > text.length
}

/**
 * Refuse a file whose bytes would be noise to the model if inlined as text.
 * Points at a route that does work: the agent's own tools for a file in the
 * project, and an archive attachment (which the model unpacks on demand) or the
 * agent's tools for one from elsewhere.
 */
function refuseBinaryAttachment(name: string, inProject: boolean): void {
  const instead = inProject
    ? "It's already in the project, so mention its path and the agent can open it with its tools."
    : 'Attach it inside a .zip, or copy it into the project and mention its path so the agent can open it with its tools.'
  showToast(`Can't attach ${name} — it isn't a text file. ${instead}`, { variant: 'error' })
}

/** Refuse a picked text file past {@link MAX_TEXT_ATTACHMENT_BYTES}. */
function refuseOversizedPick(name: string, bytes: number): void {
  showToast(
    `Can't attach ${name} — at ${formatByteSize(bytes)} it's too large to save with the conversation. Copy it into the project and mention its path so the agent can open it with its tools.`,
    { variant: 'error' },
  )
}

/** A dropped or picked file's on-disk path, or null for one with none (a pasted blob). */
function diskPathOf(file: File): string | null {
  const path = window.copseFiles?.pathForFile(file) ?? ''
  return path === '' ? null : path
}

/** Keep workspace-path drop tests on the two reads this adapter can perform. */
export type FileDropApi = {
  fs: Pick<ApiClient['fs'], 'readFile' | 'readImage'>
}

/** Structural drop event so tests can pass a plain object without `as DragEvent`. */
export type FileDropEvent = {
  preventDefault(): void
  stopPropagation(): void
  dataTransfer?: {
    getData(format: string): string
    files: ArrayLike<File>
  } | null
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = (): void => {
      res(expectString(r.result))
    }
    r.onerror = rej
    r.readAsDataURL(blob)
  })
}

async function attachWorkspacePath(
  path: string,
  handlers: PromptAttachmentHandlers,
  api: FileDropApi,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null,
): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path
  // A video already in the workspace is referenced where it lies; reading it as
  // text would inline binary into the prompt.
  if (isVideoFile({ name })) {
    await handlers.attachVideo({ name, mimeType: '', path })
    return
  }
  // Likewise an archive: reading a zip as text would inline binary into the
  // prompt, which is exactly what the archive attachment exists to avoid.
  if (isArchiveFile({ name })) {
    await handlers.attachArchive({ name, path })
    return
  }
  // An image the composer cannot render would otherwise fall through to the
  // text read below and inline its bytes.
  if (isUnrenderableImagePath(name)) {
    showToast(UNSUPPORTED_IMAGE_MESSAGE, { variant: 'error' })
    return
  }
  if (!owner) return
  try {
    const imageMime = isRasterImagePath(name) ? imageMimeType(name) : null
    if (imageMime) {
      const dataUrl = await api.fs.readImage(owner.projectId, owner.threadId, path)
      handlers.attachImage(dataUrl, imageMime)
      return
    }
    const content = await api.fs.readFile(owner.projectId, owner.threadId, path)
    // No size cap here (see MAX_TEXT_ATTACHMENT_BYTES): a large project file
    // still attaches, and the prompt keeps its head and tail.
    if (looksBinary(content)) {
      refuseBinaryAttachment(name, true)
      return
    }
    const relativePath = workspaceRoot ? workspaceRelativePath(path, workspaceRoot) : null
    // The root itself is '' — keep the absolute path rather than an empty one.
    handlers.attachFile({
      path: relativePath === null || relativePath === '' ? path : relativePath,
      content,
    })
  } catch {
    /* ignore read errors */
  }
}

async function attachDroppedFile(
  file: File,
  handlers: PromptAttachmentHandlers,
  api: FileDropApi,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null = null,
): Promise<void> {
  const imageMime = file.type.startsWith('image/') ? file.type : imageMimeType(file.name)
  if ((imageMime && isUnrenderableImageMime(imageMime)) || isUnrenderableImagePath(file.name)) {
    showToast(UNSUPPORTED_IMAGE_MESSAGE, { variant: 'error' })
    return
  }
  if (imageMime) {
    const dataUrl = await readAsDataUrl(file)
    const separator = dataUrl.indexOf(',')
    handlers.attachImage(
      separator === -1 ? dataUrl : `data:${imageMime};base64,${dataUrl.slice(separator + 1)}`,
      imageMime,
    )
    return
  }

  // Videos are stored and referenced, never inlined — a screen recording is far
  // too much media to put in a model's context. Checked before the
  // workspace-path branch so a recording that happens to live in the repo still
  // becomes a video attachment rather than an attempted text read.
  if (isVideoFile(file)) {
    await handlers.attachVideo({
      name: file.name,
      mimeType: file.type || 'video/mp4',
      bytes: await file.arrayBuffer(),
    })
    return
  }

  // Archives are stored and referenced, never inlined — same reasoning as
  // videos, and checked before the workspace-path branch for the same reason.
  if (isArchiveFile(file)) {
    await handlers.attachArchive({ name: file.name, bytes: await file.arrayBuffer() })
    return
  }

  const absPath = diskPathOf(file)
  // Electron gives picker files an absolute path even when they came from
  // outside the project. Only send an in-workspace path through the guarded
  // workspace reader; external picker files must be read from their File blob.
  // Otherwise the guarded read rejects the path and this attachment disappears.
  if (absPath && workspaceRoot && workspaceRelativePath(absPath, workspaceRoot) !== null) {
    await attachWorkspacePath(absPath, handlers, api, workspaceRoot, owner)
    return
  }

  try {
    // Text or binary is decided before size, on up to the cap: a large .ai
    // opens with tens of KB of XML metadata before its first binary stream, so
    // a small head would pass as text and get the wrong refusal.
    const head = await file.slice(0, MAX_TEXT_ATTACHMENT_BYTES).text()
    if (looksBinary(head)) {
      refuseBinaryAttachment(file.name, false)
      return
    }
    if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
      refuseOversizedPick(file.name, file.size)
      return
    }
    // Within the cap, the slice is the whole file.
    handlers.attachFile({ path: absPath ?? file.name, content: head })
  } catch {
    /* ignore read errors */
  }
}

export async function attachFiles(
  files: File[],
  handlers: PromptAttachmentHandlers,
  api: FileDropApi,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null = null,
): Promise<void> {
  for (const file of files) {
    await attachDroppedFile(file, handlers, api, workspaceRoot, owner)
  }
}

export async function handleFileDrop(
  e: FileDropEvent,
  handlers: PromptAttachmentHandlers,
  api: FileDropApi,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null = null,
): Promise<void> {
  e.preventDefault()
  e.stopPropagation()

  const workspacePath = e.dataTransfer?.getData(WORKSPACE_PATH_MIME)
  if (workspacePath) {
    await attachWorkspacePath(workspacePath, handlers, api, workspaceRoot, owner)
    return
  }

  const files = Array.from(e.dataTransfer?.files ?? [])
  await attachFiles(files, handlers, api, workspaceRoot, owner)
}

export function bindFileDropTarget(
  el: HTMLElement,
  getHandlers: () => PromptAttachmentHandlers | null,
  api: FileDropApi,
  getContext: () => { workspaceRoot: string | null; owner: ActiveThreadOwner | null },
): () => void {
  const onDragOver = (e: DragEvent): void => {
    if (!getHandlers()) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    el.classList.add('is-drop-target')
  }

  const onDragLeave = (e: DragEvent): void => {
    if (!el.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null)) {
      el.classList.remove('is-drop-target')
    }
  }

  const onDrop = (e: DragEvent): void => {
    el.classList.remove('is-drop-target')
    const handlers = getHandlers()
    if (!handlers) return
    const { workspaceRoot, owner } = getContext()
    void handleFileDrop(e, handlers, api, workspaceRoot, owner)
  }

  el.addEventListener('dragover', onDragOver, true)
  el.addEventListener('dragleave', onDragLeave, true)
  el.addEventListener('drop', onDrop, true)

  return () => {
    el.removeEventListener('dragover', onDragOver, true)
    el.removeEventListener('dragleave', onDragLeave, true)
    el.removeEventListener('drop', onDrop, true)
    el.classList.remove('is-drop-target')
  }
}
