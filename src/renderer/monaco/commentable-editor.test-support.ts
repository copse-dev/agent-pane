import type { CommentableCodeEditor } from './diff-line-comments.ts'

/** The line-comment surface of a code editor, inert: for diff editor doubles that never draw comments. */
export function inertCommentSurface(): Omit<CommentableCodeEditor, 'updateOptions'> {
  const disposable = { dispose(): void {} }
  return {
    onMouseMove: () => disposable,
    onMouseLeave: () => disposable,
    onMouseDown: () => disposable,
    createDecorationsCollection: () => ({ set: () => [], clear(): void {} }),
    changeViewZones(): void {},
  }
}
