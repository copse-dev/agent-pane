import type * as Monaco from 'monaco-editor'

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
