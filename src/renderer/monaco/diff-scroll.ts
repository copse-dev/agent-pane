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
    const timeout = setTimeout(() => {
      disposable.dispose()
      resolve()
    }, timeoutMs)
    const disposable = diffEditor.onDidUpdateDiff(() => {
      clearTimeout(timeout)
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
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      viewModel.waitForDiff().catch(() => undefined),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
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

function firstPositive(...values: number[]): number | null {
  return values.find((value) => value > 0) ?? null
}

/**
 * Scroll to the first change. Call only after diff computation has finished
 * (`waitForViewModelDiff` / `onDidUpdateDiff`). Prefer a sync getLineChanges
 * scroll over Monaco's `revealFirstDiff()` — that API fire-and-forgets
 * `waitForDiff()` and surfaces unhandled "Canceled" rejections when
 * `hideUnchangedRegions` refresh cancels an in-flight compute.
 */
export function revealFirstDiffChange(diffEditor: Monaco.editor.IStandaloneDiffEditor): void {
  const [firstChange] = diffEditor.getLineChanges() ?? []
  if (!firstChange) return

  const modifiedLine = firstPositive(
    firstChange.modifiedStartLineNumber,
    firstChange.modifiedEndLineNumber,
  )
  const originalLine = firstPositive(
    firstChange.originalStartLineNumber,
    firstChange.originalEndLineNumber,
  )

  if (modifiedLine) {
    diffEditor.getModifiedEditor().revealLineInCenterIfOutsideViewport(modifiedLine)
  }
  if (originalLine) {
    diffEditor.getOriginalEditor().revealLineInCenterIfOutsideViewport(originalLine)
  }
}
