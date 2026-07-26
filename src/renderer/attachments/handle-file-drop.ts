import type { ApiClient } from '../../preload/api.d.ts'
import type { PromptAttachmentHandlers } from './prompt-attachments.ts'
import type { ActiveThreadOwner } from '../controller/active-thread-owner.ts'

export const WORKSPACE_PATH_MIME = 'application/x-copse-panel-path'

type ElectronFile = File & { path?: string }

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = (): void => {
      res(r.result as string)
    }
    r.onerror = rej
    r.readAsDataURL(blob)
  })
}

function relativeWorkspacePath(absPath: string, workspaceRoot: string | null): string {
  if (!workspaceRoot) return absPath
  const root = workspaceRoot.replace(/\/+$/, '')
  const normalized = absPath.replace(/\\/g, '/')
  const prefix = root.replace(/\\/g, '/')
  if (normalized === prefix) return ''
  if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length + 1)
  return absPath
}

async function attachWorkspacePath(
  path: string,
  handlers: PromptAttachmentHandlers,
  api: ApiClient,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null,
): Promise<void> {
  if (!owner) return
  try {
    const content = await api.fs.readFile(owner.projectId, owner.threadId, path)
    handlers.attachFile({ path: relativeWorkspacePath(path, workspaceRoot) || path, content })
  } catch {
    /* ignore read errors */
  }
}

async function attachDroppedFile(
  file: ElectronFile,
  handlers: PromptAttachmentHandlers,
  api: ApiClient,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null,
): Promise<void> {
  if (file.type.startsWith('image/')) {
    const dataUrl = await readAsDataUrl(file)
    handlers.attachImage(dataUrl, file.type)
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
  api: ApiClient,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null,
): Promise<void> {
  for (const file of files) {
    await attachDroppedFile(file, handlers, api, workspaceRoot, owner)
  }
}

export async function handleFileDrop(
  e: DragEvent,
  handlers: PromptAttachmentHandlers,
  api: ApiClient,
  workspaceRoot: string | null,
  owner: ActiveThreadOwner | null,
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
  api: ApiClient,
  getContext: () => { workspaceRoot: string | null; owner: ActiveThreadOwner | null },
): () => void {
  const onDragOver = (e: DragEvent): void => {
    if (!getHandlers()) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    el.classList.add('is-drop-target')
  }

  const onDragLeave = (e: DragEvent): void => {
    if (!el.contains(e.relatedTarget as Node)) {
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
