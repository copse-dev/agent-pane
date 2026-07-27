import type * as Monaco from 'monaco-editor'
import type { GitFileDiff } from '@shared/types/git.ts'
import {
  GIT_CHANGES_DIFF_EDITOR_OPTIONS,
  refreshGitChangesDiffCollapse,
  revealFirstDiffChange,
  waitForViewModelDiff,
} from './diff-scroll.ts'
import type { MonacoShortcutApi, MonacoShortcutSource } from './selection-to-chat.ts'

export interface GitDiffModel {
  dispose(): void
  getValue(): string
}

export interface GitDiffCodeEditor extends MonacoShortcutSource {
  revealLineInCenterIfOutsideViewport(line: number): void
}

export interface GitDiffViewModel {
  readonly model?: { original: GitDiffModel; modified: GitDiffModel }
  dispose(): void
  waitForDiff(): Promise<unknown>
}

export interface GitDiffEditor {
  createViewModel(model: { original: GitDiffModel; modified: GitDiffModel }): GitDiffViewModel
  dispose(): void
  getLineChanges(): Array<{
    originalStartLineNumber: number
    originalEndLineNumber: number
    modifiedStartLineNumber: number
    modifiedEndLineNumber: number
  }> | null
  getModel(): { original: GitDiffModel; modified: GitDiffModel } | null
  getModifiedEditor(): GitDiffCodeEditor
  getOriginalEditor(): GitDiffCodeEditor
  layout(): void
  onDidUpdateDiff(listener: () => void): { dispose(): void }
  setModel(
    model: { original: GitDiffModel; modified: GitDiffModel } | GitDiffViewModel | null,
  ): void
  updateOptions(options: Monaco.editor.IDiffEditorOptions): void
}

export interface GitDiffMonaco extends MonacoShortcutApi {
  editor: {
    createDiffEditor(
      container: HTMLElement,
      options: Monaco.editor.IStandaloneDiffEditorConstructionOptions,
    ): GitDiffEditor
    createModel(value: string, language?: string, uri?: { toString(): string }): GitDiffModel
    setTheme(theme: string): void
  }
  Uri: { parse(value: string): { toString(): string } }
}

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
  monaco: GitDiffMonaco,
  fontSize: number,
  theme: 'vs' | 'vs-dark',
): GitDiffEditor {
  return monaco.editor.createDiffEditor(container, {
    ...GIT_CHANGES_DIFF_EDITOR_OPTIONS,
    fontSize,
    theme,
  })
}

export function disposeDiffModels(diffEditor: GitDiffEditor): void {
  const oldModels = diffEditor.getModel()
  if (!oldModels) return
  diffEditor.setModel(null)
  oldModels.original.dispose()
  oldModels.modified.dispose()
}

/**
 * Attach a git/proposed file diff and scroll to the first change.
 *
 * Uses createViewModel + waitForDiff so computation finishes before the model
 * is shown — important right after lazy Monaco load, when the editor worker may
 * still be bootstrapping and a bare setModel + immediate getLineChanges() race
 * leaves the reveal as a no-op (change off-screen / collapse unset).
 */
export async function setGitFileDiffModel(
  diffEditor: GitDiffEditor,
  monaco: GitDiffMonaco,
  diff: GitFileDiff,
  host: HTMLElement,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  await whenDiffHostVisible(host)
  if (!isCurrent()) return false

  disposeDiffModels(diffEditor)
  const version = diffModelVersion++
  const safePath = diff.path.replace(/[^a-zA-Z0-9._/-]/g, '_')
  const original = monaco.editor.createModel(
    diff.before,
    diff.language,
    monaco.Uri.parse(`inmemory://git-changes/${String(version)}/original/${safePath}`),
  )
  const modified = monaco.editor.createModel(
    diff.after,
    diff.language,
    monaco.Uri.parse(`inmemory://git-changes/${String(version)}/modified/${safePath}`),
  )
  const viewModel = diffEditor.createViewModel({ original, modified })
  await waitForViewModelDiff(viewModel, 2_000)
  if (!isCurrent()) {
    viewModel.dispose()
    original.dispose()
    modified.dispose()
    return false
  }
  diffEditor.setModel(viewModel)

  await refreshGitChangesDiffCollapse(diffEditor)
  diffEditor.layout()
  if (isCurrent()) revealFirstDiffChange(diffEditor)
  return true
}

export function observeDiffHostLayout(
  host: HTMLElement,
  getDiffEditor: () => GitDiffEditor | null,
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
