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
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
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
}

function firstPositive(...values: number[]): number | null {
  return values.find((value) => value > 0) ?? null
}

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

export function revealFirstDiffChangeOnNextUpdate(
  diffEditor: Monaco.editor.IStandaloneDiffEditor,
): () => void {
  let disposed = false
  const disposable = diffEditor.onDidUpdateDiff(() => {
    if (disposed) return
    disposed = true
    disposable.dispose()
    revealFirstDiffChange(diffEditor)
  })

  return () => {
    disposed = true
    disposable.dispose()
  }
}
