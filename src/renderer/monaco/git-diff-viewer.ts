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
  /**
   * Present on Monaco's diff editor widget but absent from the published
   * `monaco.d.ts`, hence optional. It is the only place `quitEarly` is
   * observable: a compute that hit `maxComputationTime` still reports
   * non-null line changes (one degenerate whole-file hunk).
   */
  getDiffComputationResult?(): { quitEarly: boolean } | null
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

/**
 * Whether each editor's current attach has presented a *computed* diff —
 * collapse and first-change reveal ran after the worker produced line changes.
 * False when the attach outran the compute (waitForViewModelDiff timed out on a
 * large diff): the viewer then shows plain unhighlighted text from line 1, with
 * unchanged regions expanded — the "no diff colouring" Changes pane of #1753.
 * 'quit-early' when the compute itself gave up (`maxComputationTime`): the
 * result *looks* presentable (non-null line changes) but is one degenerate
 * whole-file hunk, and Monaco will not recompute for the same models — only a
 * model rebuild can heal it.
 */
const presentedDiffs = new WeakMap<GitDiffEditor, boolean | 'quit-early'>()

/** One-shot late-compute listener armed for each editor's current attach. */
const pendingPresentations = new WeakMap<GitDiffEditor, { dispose(): void }>()

function dropPendingPresentation(diffEditor: GitDiffEditor): void {
  pendingPresentations.get(diffEditor)?.dispose()
  pendingPresentations.delete(diffEditor)
}

export function disposeDiffModels(diffEditor: GitDiffEditor): void {
  const oldModels = diffEditor.getModel()
  const oldViewModel = attachedViewModels.get(diffEditor)
  attachedViewModels.delete(diffEditor)
  attachedDiffIds.delete(diffEditor)
  presentedDiffs.delete(diffEditor)
  dropPendingPresentation(diffEditor)
  if (!oldModels && !oldViewModel) return
  diffEditor.setModel(null)
  oldViewModel?.dispose()
  oldModels?.original.dispose()
  oldModels?.modified.dispose()
}

/**
 * Collapse unchanged regions and scroll to the first change, then record
 * whether that presentation ran against a computed diff. When the compute is
 * still in flight (`getLineChanges()` null), arm a one-shot re-present on the
 * editor's next diff update: without it a large diff that outruns the attach
 * budget is shown as plain uncollapsed text from line 1 and — because the
 * identical-content skip below never rebuilds it — stays that way through every
 * later refresh while a freshly-mounted window (e.g. a pop-out) of the same
 * file presents fine (#1753).
 */
async function presentAttachedDiff(
  diffEditor: GitDiffEditor,
  isCurrent: () => boolean,
): Promise<void> {
  dropPendingPresentation(diffEditor)
  await refreshGitChangesDiffCollapse(diffEditor)
  diffEditor.layout()
  if (isCurrent()) revealFirstDiffChange(diffEditor)
  const presented = diffEditor.getLineChanges() !== null
  // A compute that hit maxComputationTime reports non-null line changes too —
  // one degenerate whole-file hunk. Recording that as presented would let the
  // identical-content skip pin the hunk-less view until the file's bytes
  // change; record it distinctly so the next entry rebuilds instead.
  const quitEarly = presented && diffEditor.getDiffComputationResult?.()?.quitEarly === true
  presentedDiffs.set(diffEditor, quitEarly ? 'quit-early' : presented)
  if (presented || !isCurrent()) return
  const subscription = diffEditor.onDidUpdateDiff(() => {
    // The collapse dance above also emits diff updates; only a finished compute
    // (non-null line changes) is worth a re-present, so keep listening past
    // interim events rather than looping on our own refresh.
    if (!isCurrent()) {
      dropPendingPresentation(diffEditor)
      return
    }
    if (diffEditor.getLineChanges() === null) return
    dropPendingPresentation(diffEditor)
    void presentAttachedDiff(diffEditor, isCurrent)
  })
  pendingPresentations.set(diffEditor, subscription)
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
 *
 * Identical before/after content is a no-op: status/fs refresh broadcasts
 * (main window and pop-outs alike, via registerAppWindow) can re-enter here
 * continuously with unchanged content. Rebuilding would only replay the
 * hideUnchangedRegions flash.
 */
/**
 * Identity of the diff each editor currently displays. The models themselves
 * only carry text, so content equality alone cannot tell "the same file,
 * refreshed" from "a different file that happens to read identically" — and
 * short-circuiting on the latter would leave the previous file's models, and its
 * language, on screen under the new selection.
 */
const attachedDiffIds = new WeakMap<GitDiffEditor, { path: string; language: string }>()

function isSameAttachedDiff(diffEditor: GitDiffEditor, diff: GitFileDiff): boolean {
  const attached = diffEditor.getModel()
  if (!attached) return false
  const id = attachedDiffIds.get(diffEditor)
  if (id?.path !== diff.path || id.language !== diff.language) return false
  return attached.original.getValue() === diff.before && attached.modified.getValue() === diff.after
}

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
  // Main-window Changes re-enters this path on every fs:changed / status refresh
  // even when the selected file is unchanged. Rebuilding models then toggles
  // hideUnchangedRegions off→on (refreshGitChangesDiffCollapse), which is the
  // expand/collapse flash — skip the no-op remount so the docked pane stays as
  // stable as a pop-out showing the same file. The one exception: an attach
  // whose diff compute never finished has no presentation worth preserving
  // (plain uncoloured text, nothing collapsed, #1753) — re-present it instead
  // of pinning the broken view until the file itself changes.
  if (isSameAttachedDiff(diffEditor, diff)) {
    const presentation = presentedDiffs.get(diffEditor)
    // A quit-early presentation is the one same-diff case that must NOT
    // short-circuit: re-presenting cannot help (Monaco will not recompute for
    // the same models), so fall through to a full model rebuild for a fresh
    // compute. One rebuild per entry cannot tight-loop — this path only runs
    // on an explicit re-selection or debounced refresh, each user/event-driven.
    if (presentation !== 'quit-early') {
      // Gated on a *finished* compute: re-running the collapse dance
      // mid-compute could restart it on every debounced refresh; the
      // pending-presentation listener armed at attach time handles the
      // in-flight case.
      if (presentation === false && diffEditor.getLineChanges() !== null) {
        await presentAttachedDiff(diffEditor, isCurrent)
      }
      return true
    }
  }

  // A previous attach may still have its one-shot late-compute listener armed
  // (context-panel calls in without isCurrent, so it never self-cancels). The
  // setModel below emits onDidUpdateDiff, which would fire that stale listener
  // into a duplicate presentAttachedDiff racing this attach's own — interleaved
  // hideUnchangedRegions toggles and a duplicate reveal scroll. Drop it before
  // any model work; the same-diff short-circuit above must NOT drop it, because
  // an in-flight compute's heal depends on that armed listener.
  dropPendingPresentation(diffEditor)

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
  attachedDiffIds.set(diffEditor, { path: diff.path, language: diff.language })
  previousViewModel?.dispose()
  previousModels?.original.dispose()
  previousModels?.modified.dispose()

  await presentAttachedDiff(diffEditor, isCurrent)
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
