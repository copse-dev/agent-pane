/**
 * Shared shell for full-screen overlay dialogs (Settings, onboarding): a native
 * `<dialog>` appended to `<body>` and opened with `showModal()`, so the platform
 * handles focus-trapping, inert background, top-layer stacking, and
 * Esc-to-close — replacing the hand-rolled div overlay + manual `hidden`
 * toggles. Esc, close buttons, and programmatic `close()` all funnel through
 * the dialog's native `close` event, which is where consumers do their cleanup.
 *
 * Dialogs built through this helper are also covered by the global
 * `dialog { -webkit-app-region: no-drag; }` rule (forms.css), so their
 * controls can never be swallowed by a titlebar/window drag region behind
 * them (issue #1914).
 */

export interface OverlayDialog {
  dialog: HTMLDialogElement
  /** Open in the top layer via showModal(); no-op when already open. */
  open: () => void
  /** Close (fires the native `close` event); no-op when already closed. */
  close: () => void
  isOpen: () => boolean
}

export function createOverlayDialog(opts: { id: string; className?: string }): OverlayDialog {
  const dialog = document.createElement('dialog')
  dialog.id = opts.id
  if (opts.className) dialog.className = opts.className
  document.body.append(dialog)
  return {
    dialog,
    open: (): void => {
      if (!dialog.open) dialog.showModal()
    },
    close: (): void => {
      if (dialog.open) dialog.close()
    },
    isOpen: (): boolean => dialog.open,
  }
}

/**
 * Whether any `<dialog>` in the document is currently open.
 *
 * Asked by global keyboard shortcuts, which must defer to whatever the user is
 * answering rather than act on the screen behind it. Cmd/Ctrl+W is the case
 * that made this necessary: it deletes the active thread, and with Settings —
 * or any other dialog — on screen the keystroke a user meant as "close this"
 * destroyed a conversation instead (#2474).
 *
 * Read off the DOM rather than from a list of `isXOpen()` predicates. There are
 * seventeen dialogs in the renderer and the one hand-maintained list of them
 * named four, which is the failure this is shaped to avoid: a new dialog is
 * covered the moment it exists, without anyone remembering to add it here.
 *
 * The `open` attribute is set by both `show()` and `showModal()`, so a
 * non-modal prompt sitting over the chat counts too — it is still a question
 * the user is in the middle of.
 */
export function isAnyDialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null
}
