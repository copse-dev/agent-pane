import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { getActiveThreadOwner, requireActiveThreadOwner } from './active-thread-owner.ts'
import { openBrowserUrl } from './panels.ts'
import { isImagePath, isRasterImagePath } from '@shared/fs/image-path.ts'
import { openAttachmentPreview } from '../attachments/attachment-preview.ts'
import { el } from '../dom/helpers.ts'
import { errorMessage } from '@shared/errors.ts'

const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  md: 'markdown',
  mdx: 'markdown',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  toml: 'ini',
  xml: 'xml',
  sql: 'sql',
  graphql: 'graphql',
}

export function detectLanguage(filePath: string): string {
  const lower = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  return LANG[lower.split('.').pop() ?? ''] ?? 'plaintext'
}

export async function openWorkspaceFile(
  store: AppStore,
  api: ApiClient,
  path: string,
  reveal?: { line: number; column?: number },
): Promise<void> {
  const { projectId, threadId } = requireActiveThreadOwner(store)
  if (isImagePath(path) && (!reveal || isRasterImagePath(path))) {
    const unsubs: (() => void)[] = []
    const preview = openAttachmentPreview({
      kind: 'image',
      title: path,
      ariaLabel: `Image preview: ${path}`,
      onClose: () => {
        for (const unsubscribe of unsubs) unsubscribe()
      },
    })
    const isOwner = (): boolean => {
      const current = getActiveThreadOwner(store)
      return current?.projectId === projectId && current.threadId === threadId
    }
    const checkOwner = (): void => {
      if (!isOwner()) preview.close()
    }
    unsubs.push(
      store.on('panel_changed', checkOwner),
      store.on('threads_changed', checkOwner),
      store.on('workspace_changed', checkOwner),
      store.on('thread_checkout_changed', (changedThreadId) => {
        if (changedThreadId === threadId) preview.close()
      }),
    )
    try {
      const src = await api.fs.readImage(projectId, threadId, path)
      if (!isOwner()) {
        preview.close()
        return
      }
      preview.setContent(el('img', { class: 'image-expand-image', src, alt: path }))
    } catch (error) {
      if (!isOwner()) {
        preview.close()
        return
      }
      preview.setStatus(`Could not preview ${path}: ${errorMessage(error)}`)
    }
    return
  }
  const content = await api.fs.readFile(projectId, threadId, path)
  const currentOwner = getActiveThreadOwner(store)
  if (currentOwner?.projectId !== projectId || currentOwner.threadId !== threadId) return
  store.setState({
    openFile: { path, content, language: detectLanguage(path), ...(reveal ? { reveal } : {}) },
    panelTab: 'file',
    rightPanelMode: 'explorer',
    filesPaneOpen: true,
  })
  store.emit('panel_changed')
  store.emit('right_panel_mode_changed')
  store.emit('files_pane_changed')
}

/** Open a local workspace file using the user's global browser preference. */
export async function openWorkspaceFileInBrowser(
  store: AppStore,
  api: ApiClient,
  path: string,
): Promise<void> {
  const { projectId, threadId } = requireActiveThreadOwner(store)
  if (store.getState().openLinksInBuiltInBrowser) {
    const url = await api.browser.workspaceFileUrl(projectId, threadId, path)
    openBrowserUrl(store, url)
    return
  }
  await api.shell.openWorkspaceFileInBrowser(projectId, threadId, path)
}

/** Browser preview is local-only; SSH paths are meaningful only on the remote host. */
export function canOpenWorkspaceFileInBrowser(store: AppStore): boolean {
  const { activeProjectId, projects } = store.getState()
  const activeProject = projects.find((project) => project.id === activeProjectId)
  return activeProject !== undefined && activeProject.sshHost === undefined
}

/** Reveal a workspace directory in the explorer tree without opening a file viewer tab. */
export function revealWorkspaceDirectory(store: AppStore, path: string): void {
  store.setState({
    openFile: null,
    panelTab: 'file',
    rightPanelMode: 'explorer',
    filesPaneOpen: true,
  })
  store.emit('explorer_reveal', path)
  store.emit('panel_changed')
  store.emit('right_panel_mode_changed')
  store.emit('files_pane_changed')
}

export async function activateWorkspaceReference(
  store: AppStore,
  api: ApiClient,
  path: string,
  kind: 'file' | 'directory',
  reveal?: { line: number; column?: number },
): Promise<void> {
  if (kind === 'directory') {
    revealWorkspaceDirectory(store, path)
    return
  }
  await openWorkspaceFile(store, api, path, reveal)
}
