import type * as Monaco from 'monaco-editor'
import type { AppState } from '@shared/types/state.ts'
import { scaledEditorFontSize } from '@shared/ui-scale.ts'

export function editorFontSizeFromState(state: Pick<AppState, 'fontSize' | 'uiScale'>): number {
  return scaledEditorFontSize(state.fontSize, state.uiScale)
}

export function updateCodeEditorFontSize(
  editor: Monaco.editor.IStandaloneCodeEditor,
  fontSize: number,
): void {
  editor.updateOptions({ fontSize })
}

export function updateDiffEditorFontSize(
  editor: Monaco.editor.IStandaloneDiffEditor,
  fontSize: number,
): void {
  editor.getOriginalEditor().updateOptions({ fontSize })
  editor.getModifiedEditor().updateOptions({ fontSize })
}
