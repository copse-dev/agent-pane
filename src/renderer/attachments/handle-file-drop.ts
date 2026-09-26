import type { ApiClient } from '../../preload/api.d.ts'
import { isVideoFile } from '@shared/video/video-media.ts'
import { isArchiveFile } from '@shared/archive/archive-media.ts'
import type { PromptAttachmentHandlers } from './prompt-attachments.ts'
import type { ActiveThreadOwner } from '../controller/active-thread-owner.ts'
import { expectString } from '@shared/unknown-value.ts'
import { imageMimeType, isRasterImagePath } from '@shared/fs/image-path.ts'
import { workspaceRelativePath } from '@shared/fs/workspace-path.ts'

export const WORKSPACE_PATH_MIME = 'application/x-copse-panel-path'

type ElectronFile = File & { path?: string }

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
  if (!owner) return
  try {
    const imageMime = isRasterImagePath(name) ? imageMimeType(name) : null
    if (imageMime) {
      const dataUrl = await api.fs.readImage(owner.projectId, owner.threadId, path)
      handlers.attachImage(dataUrl, imageMime)
      return
    }
    const content = await api.fs.readFile(owner.projectId, owner.threadId, path)
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
  file: ElectronFile,
  handlers: PromptAttachmentHandlers,
  api: FileDropApi,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null = null,
): Promise<void> {
  const imageMime = file.type.startsWith('image/') ? file.type : imageMimeType(file.name)
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

  const absPath = file.path
  if (absPath && workspaceRoot) {
    await attachWorkspacePath(absPath, handlers, api, workspaceRoot, owner)
    return
  }

  try {
    const content = await file.text()
    handlers.attachFile({ path: absPath ?? file.name, content })
  } catch {
    /* ignore read errors */
  }
}

export async function attachFiles(
  files: ElectronFile[],
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

  const files = Array.from(e.dataTransfer?.files ?? []) as ElectronFile[]
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
