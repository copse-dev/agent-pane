import {
  init_nullish,
  isNonEmptyString
} from "./chunk-WL34AAUC.js";
import {
  el,
  init_helpers
} from "./chunk-EMIRHVRH.js";
import {
  __esm
} from "./chunk-WW3EXSJD.js";

// src/shared/nullish.ts
var init_nullish2 = __esm({
  "src/shared/nullish.ts"() {
    init_nullish();
  }
});

// src/renderer/ui/cx.ts
function cx(...parts) {
  return parts.filter(isNonEmptyString).join(" ");
}
var init_cx = __esm({
  "src/renderer/ui/cx.ts"() {
    init_nullish2();
  }
});

// src/renderer/ui/actions.ts
function ensureDefined() {
  if (customElements.get(CopseUiActions.tagName) === void 0) {
    customElements.define(CopseUiActions.tagName, CopseUiActions);
  }
}
function isUiActionsOptions(value) {
  return typeof value === "object" && value !== null && !(value instanceof HTMLElement) && ("align" in value || "className" in value || Object.keys(value).length === 0);
}
function uiActions(...args) {
  ensureDefined();
  const last = args.at(-1);
  const hasOptions = last !== void 0 && isUiActionsOptions(last);
  const options = hasOptions ? last : {};
  const buttons = (hasOptions ? args.slice(0, -1) : args).filter(
    (node) => node instanceof HTMLElement
  );
  const row = document.createElement(CopseUiActions.tagName);
  const align = options.align ?? "end";
  row.setAttribute("align", align);
  row.dataset["align"] = align;
  row.className = cx("ui-actions", options.className);
  row.append(...buttons);
  return row;
}
var CopseUiActions;
var init_actions = __esm({
  "src/renderer/ui/actions.ts"() {
    init_cx();
    CopseUiActions = class extends HTMLElement {
      static tagName = "copse-ui-actions";
      connectedCallback() {
        this.classList.add("ui-actions");
        const align = this.getAttribute("align");
        if (align === "start" || align === "end" || align === "stretch") {
          this.dataset["align"] = align;
        } else {
          this.dataset["align"] ??= "end";
        }
      }
    };
  }
});

// src/renderer/ui/field.ts
function ensureDefined2() {
  if (customElements.get(CopseUiField.tagName) === void 0) {
    customElements.define(CopseUiField.tagName, CopseUiField);
  }
}
function uiField(opts) {
  ensureDefined2();
  const field = document.createElement(CopseUiField.tagName);
  field.setAttribute("label", opts.label);
  if (opts.hint !== void 0 && opts.hint !== "") field.setAttribute("hint", opts.hint);
  field.className = cx("ui-field", opts.className);
  field.append(opts.control);
  if (!(field instanceof CopseUiField)) {
    throw new Error("copse-ui-field custom element failed to upgrade");
  }
  field.ensureStructure();
  return field;
}
var CopseUiField;
var init_field = __esm({
  "src/renderer/ui/field.ts"() {
    init_helpers();
    init_cx();
    CopseUiField = class extends HTMLElement {
      static tagName = "copse-ui-field";
      static observedAttributes = ["label", "hint"];
      connectedCallback() {
        this.ensureStructure();
      }
      attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;
        if (!this.isConnected || !this.hasAttribute("data-ui-ready")) return;
        if (name === "label") {
          const labelEl = this.querySelector(":scope > .ui-field-label");
          if (labelEl) labelEl.textContent = newValue ?? "";
          return;
        }
        if (name === "hint") {
          const existing = this.querySelector(":scope > .ui-field-hint");
          if (newValue === null || newValue === "") {
            existing?.remove();
            return;
          }
          if (existing) {
            existing.textContent = newValue;
            return;
          }
          this.append(el("span", { class: "ui-field-hint field-hint" }, newValue));
        }
      }
      /** Public so factories can assemble structure before the node is connected. */
      ensureStructure() {
        if (this.hasAttribute("data-ui-ready")) return;
        this.setAttribute("data-ui-ready", "");
        this.classList.add("ui-field");
        const label = this.getAttribute("label") ?? "";
        const hint = this.getAttribute("hint");
        const controls = [...this.childNodes];
        const labelEl = el("span", { class: "ui-field-label" }, label);
        const children = [labelEl, ...controls];
        if (hint) children.push(el("span", { class: "ui-field-hint field-hint" }, hint));
        this.replaceChildren(...children);
      }
    };
  }
});

// src/renderer/ui/register.ts
function registerUiKit() {
  if (registered) return;
  registered = true;
  if (customElements.get(CopseUiActions.tagName) === void 0) {
    customElements.define(CopseUiActions.tagName, CopseUiActions);
  }
  if (customElements.get(CopseUiField.tagName) === void 0) {
    customElements.define(CopseUiField.tagName, CopseUiField);
  }
}
var registered;
var init_register = __esm({
  "src/renderer/ui/register.ts"() {
    init_actions();
    init_field();
    registered = false;
  }
});

// src/renderer/ui/pane-tabs.ts
function uiPaneTabsShell(opts) {
  const titleEl = el("span", { class: "pane-header-title" }, opts.title);
  const listHeader = el(
    "div",
    { class: cx("pane-header ui-pane-tabs-header", opts.headerClassName) },
    titleEl
  );
  const tabsWrap = el("div", { class: cx("ui-pane-tabs-list", opts.listClassName) });
  const body = el("div", { class: cx("ui-pane-tabs-body", opts.bodyClassName) });
  return { listHeader, titleEl, tabsWrap, body };
}
function uiPaneTab(opts) {
  opts.tabBtn.classList.add("ui-pane-tab");
  opts.panel.classList.add("ui-pane-tab-panel");
  opts.tabBtn.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest(opts.closeSelector)) return;
    opts.onSelect();
  });
  opts.tabBtn.querySelector(opts.closeSelector)?.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onClose();
  });
  return {
    setActive: (active) => {
      opts.tabBtn.classList.toggle("is-active", active);
      opts.panel.classList.toggle("is-active", active);
    },
    remove: () => {
      opts.tabBtn.remove();
      opts.panel.remove();
    }
  };
}
var init_pane_tabs = __esm({
  "src/renderer/ui/pane-tabs.ts"() {
    init_helpers();
    init_cx();
  }
});

// src/renderer/ui/index.ts
var init_ui = __esm({
  "src/renderer/ui/index.ts"() {
    init_register();
    init_cx();
    init_actions();
    init_field();
    init_pane_tabs();
    init_register();
    registerUiKit();
  }
});

// src/renderer/views/confirm-dialog.ts
function mountConfirmDialog() {
  document.getElementById("confirm-dialog")?.remove();
  showConfirmDialogImpl = null;
  const messageEl = el("h3", { class: "confirm-dialog-message" });
  const detailEl = el("p", { class: "confirm-dialog-detail" });
  const buttonsEl = uiActions({ className: "confirm-dialog-buttons" });
  const dialog = el("dialog", { id: "confirm-dialog" }, messageEl, detailEl, buttonsEl);
  document.body.append(dialog);
  const queue = [];
  let active = null;
  let confirming = false;
  let controller = null;
  function cancelActive() {
    if (!active) return;
    if (confirming) {
      if (!active.cancellable) return;
      controller?.abort();
      dialog.close();
      return;
    }
    finish(false);
  }
  function finish(confirmed) {
    if (!active) return;
    const resolve = active.resolve;
    active = null;
    confirming = false;
    controller = null;
    dialog.close();
    resolve(confirmed);
    if (queue.length > 0) {
      active = queue.shift() ?? null;
      renderActive();
    }
  }
  function renderActive() {
    if (!active) return;
    messageEl.textContent = active.message;
    if (active.detail) {
      detailEl.replaceChildren(active.detail);
      detailEl.hidden = false;
    } else {
      detailEl.textContent = "";
      detailEl.hidden = true;
    }
    const cancelLabel = active.cancelLabel ?? "Cancel";
    const confirmLabel = active.confirmLabel ?? "OK";
    const cancelBtn = el(
      "button",
      { type: "button", class: "ui-btn ui-btn-secondary confirm-dialog-cancel" },
      cancelLabel
    );
    const confirmBtn = el(
      "button",
      {
        type: "button",
        class: active.danger ? "ui-btn ui-btn-danger confirm-dialog-confirm" : "ui-btn ui-btn-primary confirm-dialog-confirm"
      },
      confirmLabel
    );
    cancelBtn.addEventListener("click", () => {
      cancelActive();
    });
    async function confirmActive() {
      if (!active || confirming) return;
      const request = active;
      if (!request.onConfirm) {
        finish(true);
        return;
      }
      confirming = true;
      controller = new AbortController();
      const signal = controller.signal;
      cancelBtn.disabled = !request.cancellable;
      confirmBtn.disabled = true;
      confirmBtn.setAttribute("aria-busy", "true");
      confirmBtn.textContent = request.confirmPendingLabel ?? `${confirmLabel}\u2026`;
      try {
        await request.onConfirm((label) => {
          if (active === request) confirmBtn.textContent = label;
        }, signal);
        if (active === request) finish(!signal.aborted);
      } catch (error) {
        if (active !== request) return;
        const reject = request.reject;
        active = null;
        confirming = false;
        controller = null;
        dialog.close();
        reject(error);
        if (queue.length > 0) {
          active = queue.shift() ?? null;
          renderActive();
        }
      }
    }
    confirmBtn.addEventListener("click", () => {
      void confirmActive();
    });
    buttonsEl.replaceChildren(cancelBtn, confirmBtn);
    dialog.showModal();
    if (active.focusCancel) cancelBtn.focus();
    else confirmBtn.focus();
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelActive();
  });
  showConfirmDialogImpl = (req) => new Promise((resolve, reject) => {
    const queued = { ...req, resolve, reject };
    if (active) queue.push(queued);
    else {
      active = queued;
      renderActive();
    }
  });
}
function showConfirmDialog(req) {
  if (!showConfirmDialogImpl) return Promise.resolve(false);
  return showConfirmDialogImpl(req);
}
var showConfirmDialogImpl;
var init_confirm_dialog = __esm({
  "src/renderer/views/confirm-dialog.ts"() {
    init_helpers();
    init_ui();
    showConfirmDialogImpl = null;
  }
});

// src/renderer/views/workspace-trust-consent.ts
function workspaceTrustDetail(unsandboxedHooks) {
  return [
    "Its instruction files join the system prompt, and the MCP servers and hooks it defines are allowed to run.",
    "Sandboxed commands that match your Settings \u2192 Permissions auto-approval level run without asking.",
    unsandboxedHooks.length > 0 ? `${String(unsandboxedHooks.length)} of those hooks declare "sandbox": false and run OUTSIDE the project sandbox: ${unsandboxedHooks.map((h) => `${h.event}: ${h.command}`).join("; ")}` : ""
  ].filter(Boolean).join(" ");
}
function confirmProjectTrust(request) {
  return showConfirmDialog({
    message: `Trust \u201C${request.projectName}\u201D?`,
    detail: `${request.lead} ${workspaceTrustDetail(request.unsandboxedHooks)}`,
    confirmLabel: "Trust project",
    ...request.cancelLabel ? { cancelLabel: request.cancelLabel } : {},
    ...request.focusCancel ? { focusCancel: true } : {}
  });
}
var init_workspace_trust_consent = __esm({
  "src/renderer/views/workspace-trust-consent.ts"() {
    init_confirm_dialog();
  }
});

export {
  init_nullish2 as init_nullish,
  uiActions,
  init_actions,
  uiField,
  registerUiKit,
  uiPaneTabsShell,
  uiPaneTab,
  init_pane_tabs,
  init_ui,
  mountConfirmDialog,
  showConfirmDialog,
  init_confirm_dialog,
  workspaceTrustDetail,
  confirmProjectTrust,
  init_workspace_trust_consent
};
