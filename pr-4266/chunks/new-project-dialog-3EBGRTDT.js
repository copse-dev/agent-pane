import {
  clear,
  el,
  init_helpers
} from "./chunk-EMIRHVRH.js";
import {
  __esm
} from "./chunk-WW3EXSJD.js";

// src/renderer/views/new-project-dialog.ts
function ensureDialog() {
  if (dialogEl) return dialogEl;
  dialogEl = el("dialog", { id: "new-project-dialog", class: "new-project-dialog" });
  document.body.append(dialogEl);
  return dialogEl;
}
function openNewProjectDialog(api, defaultParentDir) {
  const dialog = ensureDialog();
  clear(dialog);
  const nameInput = el("input", {
    type: "text",
    class: "new-project-name",
    placeholder: "my-project",
    "aria-label": "Project name",
    spellcheck: "false",
    autocomplete: "off"
  });
  const parentInput = el("input", {
    type: "text",
    class: "new-project-parent",
    placeholder: "~/Projects",
    "aria-label": "Parent directory",
    spellcheck: "false",
    autocomplete: "off"
  });
  parentInput.value = defaultParentDir;
  const browseBtn = el("button", { type: "button", class: "new-project-browse" }, "Browse\u2026");
  const pathPreview = el("p", { class: "field-hint new-project-path-preview" });
  const error = el("p", { class: "new-project-error field-hint", hidden: true });
  const okBtn = el("button", { type: "button", class: "ui-btn ui-btn-primary" }, "Create");
  const cancelBtn = el("button", { type: "button", class: "ui-btn" }, "Cancel");
  function updatePathPreview() {
    const name = nameInput.value.trim();
    const parent = parentInput.value.trim();
    pathPreview.textContent = name && parent ? `${parent}/${name}` : "";
  }
  function renderError(message) {
    error.textContent = message;
    error.hidden = false;
  }
  nameInput.addEventListener("input", updatePathPreview);
  parentInput.addEventListener("input", updatePathPreview);
  browseBtn.addEventListener("click", () => {
    void (async () => {
      const picked = await api.workspace.pickParentDirectory();
      if (picked) parentInput.value = picked;
      updatePathPreview();
    })();
  });
  dialog.append(
    el("h3", {}, "New project"),
    el(
      "p",
      { class: "field-hint" },
      "Create a folder with a starter AGENT.md and README.md, then git init it."
    ),
    el("label", { class: "new-project-field" }, "Name ", nameInput),
    el(
      "label",
      { class: "new-project-field" },
      "Parent directory ",
      el("div", { class: "new-project-parent-row" }, parentInput, browseBtn)
    ),
    pathPreview,
    error,
    el("div", { class: "new-project-actions" }, cancelBtn, okBtn)
  );
  return new Promise((resolve) => {
    let settled = false;
    const perOpen = new AbortController();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      perOpen.abort();
      dialog.close();
      resolve(value);
    };
    dialog.addEventListener(
      "cancel",
      () => {
        finish(null);
      },
      { signal: perOpen.signal }
    );
    cancelBtn.addEventListener("click", () => {
      finish(null);
    });
    okBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      const parentDir = parentInput.value.trim();
      if (!name) {
        renderError("Enter a project name.");
        return;
      }
      if (!parentDir) {
        renderError("Choose a parent directory.");
        return;
      }
      finish({ name, parentDir });
    });
    dialog.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" && e.target === nameInput) {
          e.preventDefault();
          okBtn.click();
        }
      },
      { signal: perOpen.signal }
    );
    dialog.showModal();
    nameInput.focus();
  });
}
var dialogEl;
var init_new_project_dialog = __esm({
  "src/renderer/views/new-project-dialog.ts"() {
    init_helpers();
    dialogEl = null;
  }
});
init_new_project_dialog();
export {
  openNewProjectDialog
};
