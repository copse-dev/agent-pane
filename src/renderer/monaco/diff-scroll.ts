import type * as Monaco from 'monaco-editor'

const HIDE_UNCHANGED_REGIONS = {
  enabled: true,
  contextLineCount: 3,
  minimumLineCount: 1,
  revealLineCount: 20,
}

/** Diff editor options for the git Changes panel. */
export const GIT_CHANGES_DIFF_EDITOR_OPTIONS: Monaco.editor.IDiffEditorConstructionOptions = {
  readOnly: true,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderSideBySide: true,
  useInlineViewWhenSpaceIsLimited: true,
  ignoreTrimWhitespace: false,
  renderIndicators: true,
  hideUnchangedRegions: HIDE_UNCHANGED_REGIONS,
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => {
      resolve()
    }),
  )
}

/** Resolve on the next `onDidUpdateDiff`, or after `timeoutMs` — whichever first. */
export function waitForDidUpdateDiff(
  diffEditor: Monaco.editor.IStandaloneDiffEditor,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      disposable.dispose()
      resolve()
    }, timeoutMs)
    const disposable = diffEditor.onDidUpdateDiff(() => {
      globalThis.clearTimeout(timeout)
      disposable.dispose()
      resolve()
    })
  })
}

/**
 * Await a view-model diff compute with a hard timeout. Worker bootstrap races
 * can reject with "no diff result available"; those are swallowed so the model
 * still attaches and a later reveal can retry once the worker is up.
 */
export async function waitForViewModelDiff(
  viewModel: Monaco.editor.IDiffEditorViewModel,
  timeoutMs: number,
): Promise<void> {
  let timeoutId = 0
  try {
    await Promise.race([
      viewModel.waitForDiff().catch(() => undefined),
      new Promise<void>((resolve) => {
        timeoutId = globalThis.setTimeout(() => {
          resolve()
        }, timeoutMs)
      }),
    ])
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

/** Re-apply collapse after setModel; Monaco can drop hidden regions until options refresh (#4903). */
export async function refreshGitChangesDiffCollapse(
  diffEditor: Monaco.editor.IStandaloneDiffEditor,
): Promise<void> {
  diffEditor.updateOptions({
    ...GIT_CHANGES_DIFF_EDITOR_OPTIONS,
    hideUnchangedRegions: { ...HIDE_UNCHANGED_REGIONS, enabled: false },
  })
  diffEditor.layout()
  await nextAnimationFrame()

  diffEditor.updateOptions({
    ...GIT_CHANGES_DIFF_EDITOR_OPTIONS,
    hideUnchangedRegions: HIDE_UNCHANGED_REGIONS,
  })
  diffEditor.layout()
  await nextAnimationFrame()
  // Collapse re-apply can schedule another diff-view update; give it a beat so
  // the following reveal scrolls against the collapsed viewport, not the full file.
  await waitForDidUpdateDiff(diffEditor, 250)
}

/**
 * Scroll to the first change. Prefers Monaco's built-in `revealFirstDiff`, which
 * waits for diff computation — our older getLineChanges()-immediate path no-oped
 * when the editor worker was still booting after lazy Monaco load.
 */
export function revealFirstDiffChange(diffEditor: Monaco.editor.IStandaloneDiffEditor): void {
  diffEditor.revealFirstDiff()
}
