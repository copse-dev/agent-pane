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

export type GitDiffEditorSource = GitDiffEditor | (() => GitDiffEditor)

let diffModelVersion = 0

function viewerVisible(host: HTMLElement): boolean {
  return !host.hidden && host.offsetWidth > 0 && host.offsetHeight > 0
}

function resolveDiffEditor(source: GitDiffEditorSource): GitDiffEditor {
  return typeof source === 'function' ? source() : source
}

function unrefNodeTimer(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null || !('unref' in timer)) return
  const { unref } = timer
  if (typeof unref === 'function') Reflect.apply(unref, timer, [])
}

/**
 * Wait until the diff host has a real layout box.
 *
 * Monaco diff layout is wrong when the host was `hidden` or zero-sized at
 * create/setModel time. Returns false when `isCurrent` flips while waiting so
 * callers can release a shared load queue instead of stalling behind a hidden
 * panel (e.g. Changes auto-open while `#pane-files` is still closed).
 */
export async function whenDiffHostVisible(
  host: HTMLElement,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isCurrent()) return false
  if (viewerVisible(host)) return true
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      obs.disconnect()
      mo.disconnect()
      clearInterval(poll)
      resolve(ok)
    }
    const tick = (): void => {
      if (!isCurrent()) {
        finish(false)
        return
      }
      if (viewerVisible(host)) finish(true)
    }
    const obs = new ResizeObserver(tick)
    obs.observe(host)
    // `hidden` toggles do not always produce a ResizeObserver record when an
    // ancestor stays `display:none` (size 0→0), so watch the attribute too.
    const mo = new MutationObserver(tick)
    mo.observe(host, { attributes: true, attributeFilter: ['hidden'] })
    // Ancestor unhide (e.g. `#pane-files`) can size the host without mutating
    // it; polling also lets superseded selections abandon the wait promptly.
    const poll = setInterval(tick, 32)
    // Browser timers are numeric. Under Node's DOM test environment the timer
    // is an object whose default ref would keep coverage alive indefinitely
    // whenever a mounted hidden host is intentionally still waiting.
    unrefNodeTimer(poll)
    requestAnimationFrame(tick)
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

/**
 * The view model each editor currently displays.
 *
 * `getModel()` hands back the underlying text models, not the view model built
 * around them, so an editor's own API cannot release the wrapper it was given.
 * Tracking it here lets a swap dispose the outgoing wrapper alongside its
 * models — and only once its replacement is already on screen.
 */
const attachedViewModels = new WeakMap<GitDiffEditor, GitDiffViewModel>()

export function disposeDiffModels(diffEditor: GitDiffEditor): void {
  const oldModels = diffEditor.getModel()
  const oldViewModel = attachedViewModels.get(diffEditor)
  attachedViewModels.delete(diffEditor)
  if (!oldModels && !oldViewModel) return
  diffEditor.setModel(null)
  oldViewModel?.dispose()
  oldModels?.original.dispose()
  oldModels?.modified.dispose()
}

/**
 * Attach a git/proposed file diff and scroll to the first change.
 *
 * Uses createViewModel + waitForDiff so computation finishes before the model
 * is shown — important right after lazy Monaco load, when the editor worker may
 * still be bootstrapping and a bare setModel + immediate getLineChanges() race
 * leaves the reveal as a no-op (change off-screen / collapse unset).
 *
 * Pass a factory `() => createEditor()` when the editor must not be constructed
 * until the host is visible — creating Monaco at 0×0 (panel still closed) leaves
 * a blank viewer even after later layout().
 *
 * The outgoing diff is torn down only once its replacement is attached. Clearing
 * first left the editor model-less for the whole compute, and any abandoned
 * attach — superseded selection, thread/project switch mid-compute — returned
 * with nothing put back, stranding the Changes pane on an empty editor it had
 * already unhidden: the blank Changes page of #459/#1343.
 */
export async function setGitFileDiffModel(
  diffEditorSource: GitDiffEditorSource,
  monaco: GitDiffMonaco,
  diff: GitFileDiff,
  host: HTMLElement,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const visible = await whenDiffHostVisible(host, isCurrent)
  if (!visible || !isCurrent()) return false

  const diffEditor = resolveDiffEditor(diffEditorSource)
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
  const previousModels = diffEditor.getModel()
  const previousViewModel = attachedViewModels.get(diffEditor)
  diffEditor.setModel(viewModel)
  attachedViewModels.set(diffEditor, viewModel)
  previousViewModel?.dispose()
  previousModels?.original.dispose()
  previousModels?.modified.dispose()

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
