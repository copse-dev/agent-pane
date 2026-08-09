/**
 * happy-dom renders `<dialog>` but implements none of its modality: `showModal`
 * and `close` are absent, so any component test that opens the shared
 * attachment preview throws before it can assert anything.
 *
 * Stub the two behaviours the preview actually depends on — `open` reflecting
 * state, and `close` dispatching its event so `openAttachmentPreview` runs the
 * cleanup that releases the last session's resources. Call it once per suite
 * (`before`), since it patches the prototype for the whole DOM.
 */
export function patchPreviewDialog(): void {
  Object.defineProperties(window.HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = false
        this.dispatchEvent(new window.Event('close'))
      },
    },
  })
}
