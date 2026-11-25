import {
  __esm
} from "./chunk-WW3EXSJD.js";

// src/renderer/dom/helpers.ts
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === void 0 || v === false) continue;
    if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}
function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}
function qs(root, selector) {
  return root.querySelector(selector);
}
function qsRequired(root, selector) {
  const found = root.querySelector(selector);
  if (!found) throw new Error(`qsRequired: no element matches ${JSON.stringify(selector)}`);
  return found;
}
function on(target, event, handler, opts) {
  target.addEventListener(event, handler, opts);
  return () => {
    target.removeEventListener(event, handler, opts);
  };
}
var init_helpers = __esm({
  "src/renderer/dom/helpers.ts"() {
  }
});

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
  el,
  clear,
  qs,
  qsRequired,
  on,
  init_helpers,
  createOverlayDialog,
  lazyBodyDialog,
  isAnyDialogOpen,
  init_dialog_shell
};
