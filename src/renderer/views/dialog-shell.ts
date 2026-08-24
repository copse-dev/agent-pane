/**
 * Shared shell for full-screen overlay dialogs (Settings, onboarding): a native
 * `<dialog>` appended to `<body>` and opened with `showModal()`, so the platform
 * handles focus-trapping, inert background, top-layer stacking, and
 * Esc-to-close — replacing the hand-rolled div overlay + manual `hidden`
 * toggles. Esc, close buttons, and programmatic `close()` all funnel through
 * the dialog's native `close` event, which is where consumers do their cleanup.
 *
 * Dialogs built through this helper are also covered by the global
 * `dialog { -webkit-app-region: no-drag; }` rule (layout.css), so their
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
