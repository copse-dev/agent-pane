import {
  init_inline_status,
  init_ipc_error_message,
  ipcErrorMessage,
  setInlineStatus
} from "./chunk-5VXMUG67.js";
import {
  el,
  init_helpers
} from "./chunk-EMIRHVRH.js";
import {
  __esm
} from "./chunk-WW3EXSJD.js";

// src/renderer/views/ssh-workspace-consent.ts
function createSshWorkspaceConsent(api, options) {
  const status = el("p", { class: "ssh-consent-status", role: "status" });
  const turnOn = el(
    "button",
    { type: "button", class: "ui-btn ui-btn-primary ssh-consent-turn-on" },
    "Turn on SSH workspaces"
  );
  const actions = el("div", { class: "ssh-consent-actions" });
  if (options.onCancel) {
    const cancel = el(
      "button",
      { type: "button", class: "ui-btn ui-btn-secondary ssh-consent-cancel" },
      "Cancel"
    );
    const onCancel = options.onCancel;
    cancel.addEventListener("click", () => {
      onCancel();
    });
    actions.append(cancel);
  }
  actions.append(turnOn);
  const root = el(
    "div",
    { class: "ssh-consent", role: "group", "aria-label": SSH_WORKSPACE_CONSENT_TITLE },
    el("p", { class: "ssh-consent-title" }, SSH_WORKSPACE_CONSENT_TITLE),
    el("p", { class: "ssh-consent-body" }, SSH_WORKSPACE_CONSENT_BODY),
    el(
      "p",
      { class: "ssh-consent-hint field-hint" },
      "You can turn it off again in Settings \u2192 Machines."
    ),
    status,
    actions
  );
  turnOn.addEventListener("click", () => {
    void (async () => {
      turnOn.disabled = true;
      try {
        await api.settings.set("sshWorkspaceEnabled", true);
        status.replaceChildren();
        await options.onEnabled();
      } catch (error) {
        setInlineStatus(
          status,
          "error",
          ipcErrorMessage(error, "Could not turn on SSH workspaces.")
        );
      } finally {
        turnOn.disabled = false;
      }
    })();
  });
  return { root };
}
var SSH_WORKSPACE_CONSENT_TITLE, SSH_WORKSPACE_CONSENT_BODY;
var init_ssh_workspace_consent = __esm({
  "src/renderer/views/ssh-workspace-consent.ts"() {
    init_helpers();
    init_inline_status();
    init_ipc_error_message();
    SSH_WORKSPACE_CONSENT_TITLE = "Turn on SSH workspaces?";
    SSH_WORKSPACE_CONSENT_BODY = "Copse will run shell, git, search and file tools on the machine you choose, over your own SSH setup. Copse applies no sandbox there, so it asks before running ordinary commands, as it does wherever commands run unsandboxed.";
  }
});

export {
  createSshWorkspaceConsent,
  init_ssh_workspace_consent
};
