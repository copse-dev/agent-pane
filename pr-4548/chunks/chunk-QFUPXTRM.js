import {
  __esm
} from "./chunk-WW3EXSJD.js";

// src/renderer/views/dialog-shell.ts
function createOverlayDialog(opts) {
  const dialog = document.createElement("dialog");
  dialog.id = opts.id;
  if (opts.className) dialog.className = opts.className;
  document.body.append(dialog);
  return {
    dialog,
    open: () => {
      if (!dialog.open) dialog.showModal();
    },
    close: () => {
      if (dialog.open) dialog.close();
    },
    isOpen: () => dialog.open
  };
}
function lazyBodyDialog(id, className) {
  let dialog = null;
  return () => {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = id;
    dialog.className = className;
    document.body.append(dialog);
    return dialog;
  };
}
function isAnyDialogOpen() {
  return document.querySelector("dialog[open]") !== null;
}
var init_dialog_shell = __esm({
  "src/renderer/views/dialog-shell.ts"() {
  }
});

export {
  createOverlayDialog,
  lazyBodyDialog,
  isAnyDialogOpen,
  init_dialog_shell
};
