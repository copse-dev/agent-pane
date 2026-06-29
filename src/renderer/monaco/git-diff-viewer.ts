import type * as Monaco from 'monaco-editor'
import type { GitFileDiff } from '@shared/types/git.ts'
import {
  GIT_CHANGES_DIFF_EDITOR_OPTIONS,
  refreshGitChangesDiffCollapse,
  revealFirstDiffChange,
} from './diff-scroll.ts'

let diffModelVersion = 0

function viewerVisible(host: HTMLElement): boolean {
  return !host.hidden && host.offsetWidth > 0 && host.offsetHeight > 0
}

/** Monaco diff layout is wrong when the host was `hidden` or had zero size at create/setModel time. */
export async function whenDiffHostVisible(host: HTMLElement): Promise<void> {
  if (viewerVisible(host)) return
  await new Promise<void>((resolve) => {
    const tryResolve = (): void => {
      if (!viewerVisible(host)) return
      obs.disconnect()
      resolve()
    }
    const obs = new ResizeObserver(tryResolve)
    obs.observe(host)
    requestAnimationFrame(tryResolve)
  })
}

export function createGitChangesDiffEditor(
  container: HTMLElement,
  monaco: typeof Monaco,
  fontSize: number,
  theme: 'vs' | 'vs-dark',
): Monaco.editor.IStandaloneDiffEditor {
  return monaco.editor.createDiffEditor(container, {
    ...GIT_CHANGES_DIFF_EDITOR_OPTIONS,
    fontSize,
    theme,
  })
}

export function disposeDiffModels(diffEditor: Monaco.editor.IStandaloneDiffEditor): void {
  const oldModels = diffEditor.getModel()
  if (!oldModels) return
  diffEditor.setModel(null)
  oldModels.original.dispose()
  oldModels.modified.dispose()
}

export async function setGitFileDiffModel(
  diffEditor: Monaco.editor.IStandaloneDiffEditor,
  monaco: typeof Monaco,
  diff: GitFileDiff,
  host: HTMLElement,
): Promise<void> {
  await whenDiffHostVisible(host)

  disposeDiffModels(diffEditor)
  const version = diffModelVersion++
  const safePath = diff.path.replace(/[^a-zA-Z0-9._/-]/g, '_')
  diffEditor.setModel({
    original: monaco.editor.createModel(
      diff.before,
      diff.language,
      monaco.Uri.parse(`inmemory://git-changes/${String(version)}/original/${safePath}`),
    ),
    modified: monaco.editor.createModel(
      diff.after,
      diff.language,
      monaco.Uri.parse(`inmemory://git-changes/${String(version)}/modified/${safePath}`),
    ),
  })

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(() => {
      disposable.dispose()
      resolve()
    }, 1_000)
    const disposable = diffEditor.onDidUpdateDiff(() => {
      window.clearTimeout(timeout)
      disposable.dispose()
      resolve()
    })
  })
  await refreshGitChangesDiffCollapse(diffEditor)
  diffEditor.layout()
  revealFirstDiffChange(diffEditor)
}

export function observeDiffHostLayout(
  host: HTMLElement,
  getDiffEditor: () => Monaco.editor.IStandaloneDiffEditor | null,
): () => void {
  const observer = new ResizeObserver(() => {
    if (!viewerVisible(host)) return
    getDiffEditor()?.layout()
  })
  observer.observe(host)
  return () => {
    observer.disconnect()
  }
}
