/**
 * Electron WDIO (and some real click/focus sequences) steal focus from a
 * freshly mounted rename `<input>` in the same turn as `focus()`. Blur must
 * not commit/unmount until that fight settles, or the input vanishes before
 * the user (or e2e) can type.
 */
export const RENAME_BLUR_GRACE_MS = 200

/**
 * Commit on blur only after a short grace window. During the grace, try to
 * reclaim focus instead of tearing the input down.
 */
export function bindRenameBlur(input: HTMLInputElement, commit: () => void): void {
  const mountedAt = Date.now()
  let committed = false
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (committed || document.activeElement === input) return
      if (Date.now() - mountedAt < RENAME_BLUR_GRACE_MS) {
        input.focus()
        input.select()
        return
      }
      committed = true
      commit()
    }, 0)
  })
}
