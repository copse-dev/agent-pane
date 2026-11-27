import {
  createSshWorkspaceConsent,
  init_ssh_workspace_consent
} from "./chunk-AYSMJRFY.js";
import {
  arrowLeftIcon,
  createSshHostFields,
  init_icons,
  init_inline_status,
  init_ipc_error_message,
  init_ssh_host_fields,
  init_ssh_host_helpers,
  init_toast,
  ipcErrorMessage,
  parseSshWorkspaceHosts,
  saveSshConfigHost,
  setInlineStatus,
  showToast,
  unsavedSshConfigHosts,
  upsertHost
} from "./chunk-JSCSK6EX.js";
import "./chunk-WL34AAUC.js";
import {
  init_dialog_shell,
  lazyBodyDialog
} from "./chunk-QFUPXTRM.js";
import {
  clear,
  el,
  init_helpers
} from "./chunk-EMIRHVRH.js";
import {
  __esm
} from "./chunk-WW3EXSJD.js";

// src/renderer/controller/ssh-workspace-ui.ts
async function isSshWorkspaceEnabled(api) {
  try {
    const settings = api.settings;
    if (!settings?.get) return false;
    return await settings.get("sshWorkspaceEnabled") === true;
  } catch {
    return false;
  }
}
var init_ssh_workspace_ui = __esm({
  "src/renderer/controller/ssh-workspace-ui.ts"() {
  }
});

// src/renderer/views/remote-folder-path.ts
function initialRemoteBrowsePath(projects, hostId, home) {
  for (let index = projects.length - 1; index >= 0; index -= 1) {
    const project = projects[index];
    if (project?.sshHost !== hostId) continue;
    if (project.path.startsWith("/")) return parentRemotePath(project.path);
    break;
  }
  if (home?.startsWith("/")) return home;
  return "/";
}
function parentRemotePath(path) {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}
function remotePathSegments(path) {
  const normalized = !path || path === "/" ? "/" : path.startsWith("/") ? path.replace(/\/+$/, "") || "/" : `/${path}`;
  const segments = [{ label: "/", path: "/" }];
  if (normalized === "/") return segments;
  let acc = "";
  for (const part of normalized.split("/").filter(Boolean)) {
    acc += `/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}
function remotePathShowsSeparatorAfter(segment) {
  return segment.path !== "/";
}
function fillRemotePathBreadcrumbs(nav, path, onNavigate) {
  nav.replaceChildren();
  const segments = remotePathSegments(path);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    const isCurrent = i === segments.length - 1;
    if (isCurrent) {
      const current = document.createElement("span");
      current.className = "remote-folder-crumb remote-folder-crumb-current";
      current.textContent = segment.label;
      nav.append(current);
      continue;
    }
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "remote-folder-crumb";
    crumb.setAttribute("aria-label", `Go to ${segment.path}`);
    crumb.textContent = segment.label;
    crumb.addEventListener("click", () => {
      onNavigate(segment.path);
    });
    nav.append(crumb);
    if (remotePathShowsSeparatorAfter(segment)) {
      const sep = document.createElement("span");
      sep.className = "remote-folder-crumb-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "/";
      nav.append(sep);
    }
  }
}
var init_remote_folder_path = __esm({
  "src/renderer/views/remote-folder-path.ts"() {
  }
});

// src/renderer/views/remote-folder-dialog.ts
function openRemoteFolderDialog(api, options = {}) {
  const projects = options.projects ?? [];
  const dialog = ensureDialog();
  clear(dialog);
  const hostSelect = el("select", { class: "remote-folder-host", "aria-label": "SSH host" });
  const addHostBtn = el(
    "button",
    { type: "button", class: "ui-btn ui-btn-secondary remote-folder-add-host-btn" },
    "Add host"
  );
  const breadcrumbs = el("nav", {
    class: "remote-folder-breadcrumbs",
    "aria-label": "Remote path"
  });
  const list = el("div", { class: "remote-folder-list", role: "listbox" });
  const status = el("p", { class: "remote-folder-status field-hint" });
  const upBtn = el(
    "button",
    { type: "button", class: "remote-folder-up", "aria-label": "Go up one directory" },
    arrowLeftIcon("ui-icon ui-icon-sm"),
    "Up"
  );
  const openBtn = el(
    "button",
    { type: "button", class: "ui-btn ui-btn-primary remote-folder-open" },
    "Open"
  );
  const cancelBtn = el(
    "button",
    { type: "button", class: "ui-btn ui-btn-secondary remote-folder-cancel" },
    "Cancel"
  );
  const hostFields = createSshHostFields();
  const saveHostBtn = el(
    "button",
    { type: "button", class: "ui-btn ui-btn-primary remote-folder-save-host" },
    "Save host"
  );
  const cancelAddBtn = el(
    "button",
    { type: "button", class: "ui-btn ui-btn-secondary remote-folder-cancel-add" },
    "Cancel"
  );
  const addHostHint = el(
    "p",
    { class: "field-hint remote-folder-add-host-hint" },
    "Add an SSH host to browse and open a remote folder."
  );
  const addHostForm = el(
    "div",
    { class: "remote-folder-add-host-form ssh-host-form", hidden: true },
    addHostHint,
    ...hostFields.fields,
    el(
      "div",
      { class: "remote-folder-add-host-actions provider-actions" },
      cancelAddBtn,
      saveHostBtn
    )
  );
  const browsePanel = el(
    "div",
    { class: "remote-folder-browse" },
    el("div", { class: "remote-folder-toolbar" }, upBtn, breadcrumbs),
    list
  );
  const picker = el(
    "div",
    { class: "remote-folder-picker" },
    el("p", { class: "field-hint" }, "Choose an SSH host and folder on the remote machine."),
    el(
      "div",
      { class: "remote-folder-host-row" },
      el("label", { class: "remote-folder-host-label-wrap" }, "Host ", hostSelect),
      addHostBtn
    ),
    addHostForm,
    browsePanel,
    status,
    el("div", { class: "remote-folder-actions" }, cancelBtn, openBtn)
  );
  dialog.append(el("h3", {}, "Open remote folder"), picker);
  let hosts = [];
  let configHosts = [];
  let currentHostId = "";
  let currentPath = "/";
  let loading = false;
  let addingHost = false;
  function setAddingHost(next) {
    addingHost = next;
    addHostForm.hidden = !next;
    addHostBtn.hidden = next;
    browsePanel.hidden = next;
    openBtn.hidden = next;
    if (next) {
      hostFields.reset();
      addHostHint.textContent = hosts.length > 0 ? "Add an SSH host to browse and open a remote folder." : configHosts.length > 0 ? "No SSH hosts saved yet. Choose one from ~/.ssh/config above, or add one here." : "No SSH hosts yet. Add one to browse and open a remote folder.";
      status.textContent = "";
      hostFields.focus();
    }
  }
  function fillHostSelect(selectedId) {
    clear(hostSelect);
    for (const host of hosts) {
      hostSelect.append(el("option", { value: host.id }, `${host.label} (${host.host})`));
    }
    if (configHosts.length > 0) {
      hostSelect.append(
        el(
          "optgroup",
          { label: "In ~/.ssh/config" },
          ...configHosts.map(
            (host) => el("option", { value: `${SSH_CONFIG_OPTION}${host.host}` }, host.host)
          )
        )
      );
    }
    if (hosts.length === 0) {
      hostSelect.prepend(
        el(
          "option",
          { value: "", disabled: true, selected: true },
          configHosts.length > 0 ? "Choose a host" : "No hosts yet"
        )
      );
      hostSelect.disabled = configHosts.length === 0;
      currentHostId = "";
      return;
    }
    hostSelect.disabled = false;
    const preferred = (selectedId && hosts.some((h) => h.id === selectedId) ? selectedId : void 0) ?? hosts[0]?.id ?? "";
    currentHostId = preferred;
    hostSelect.value = preferred;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };
    dialog.addEventListener("cancel", () => {
      finish(null);
    });
    cancelBtn.addEventListener("click", () => {
      finish(null);
    });
    addHostBtn.addEventListener("click", () => {
      setAddingHost(true);
    });
    cancelAddBtn.addEventListener("click", () => {
      if (hosts.length === 0) {
        finish(null);
        return;
      }
      setAddingHost(false);
      status.textContent = "";
    });
    async function reloadHosts() {
      const [saved, aliases] = await Promise.all([
        api.sshWorkspace.listHosts(),
        api.sshWorkspace.listConfigAliases().catch(() => [])
      ]);
      hosts = saved;
      configHosts = unsavedSshConfigHosts(saved, aliases);
    }
    async function persistAndSelect(hostId, label) {
      await reloadHosts();
      fillHostSelect(hostId);
      setAddingHost(false);
      status.textContent = `Saved host \u201C${label}\u201D.`;
      await browseStart();
    }
    saveHostBtn.addEventListener("click", () => {
      void (async () => {
        try {
          const existing = parseSshWorkspaceHosts(await api.settings.get("sshWorkspaceHosts"));
          const parsed = hostFields.parse(existing);
          if (!parsed.ok) {
            setInlineStatus(status, "error", parsed.error);
            return;
          }
          await api.settings.set("sshWorkspaceHosts", upsertHost(existing, parsed.host));
          await persistAndSelect(parsed.host.id, parsed.host.label);
        } catch (err) {
          const message = ipcErrorMessage(err, "Could not save the host.");
          setInlineStatus(status, "error", message);
          showToast(message, { variant: "error" });
        }
      })();
    });
    async function chooseConfigHost(alias) {
      const chosen = configHosts.find((host) => host.host === alias);
      if (!chosen) return;
      try {
        const existing = parseSshWorkspaceHosts(await api.settings.get("sshWorkspaceHosts"));
        const saved = saveSshConfigHost(existing, chosen);
        await api.settings.set("sshWorkspaceHosts", saved.hosts);
        await persistAndSelect(saved.hostId, chosen.label);
      } catch (err) {
        const message = ipcErrorMessage(err, "Could not save the host.");
        setInlineStatus(status, "error", message);
        showToast(message, { variant: "error" });
      }
    }
    async function loadHosts() {
      status.textContent = "Loading hosts\u2026";
      try {
        await reloadHosts();
        fillHostSelect();
        if (hosts.length === 0) {
          openBtn.disabled = true;
          upBtn.disabled = true;
          setAddingHost(true);
          return;
        }
        setAddingHost(false);
        await browseStart();
      } catch (err) {
        setInlineStatus(status, "error", ipcErrorMessage(err, "Could not load SSH hosts."));
      }
    }
    let listing = 0;
    function browseStart() {
      return browse(null);
    }
    function renderBreadcrumbs(path) {
      fillRemotePathBreadcrumbs(breadcrumbs, path, (next) => {
        void browse(next);
      });
    }
    async function browse(path) {
      const hostId = currentHostId;
      if (!hostId || addingHost || loading && path !== null) return;
      const run = ++listing;
      loading = true;
      openBtn.disabled = true;
      upBtn.disabled = true;
      status.textContent = "Connecting\u2026";
      clear(list);
      let target = path ?? "/";
      try {
        const states = await api.sshWorkspace.connect(hostId);
        if (run !== listing) return;
        if (path === null) {
          const home = states.find((state) => state.hostId === hostId)?.capabilities?.home;
          target = initialRemoteBrowsePath(projects, hostId, home);
        }
        currentPath = target;
        renderBreadcrumbs(currentPath);
        let entries;
        try {
          entries = await api.sshWorkspace.listDirectory(hostId, target);
        } catch (err) {
          if (path !== null || target === "/" || run !== listing) throw err;
          target = "/";
          currentPath = target;
          renderBreadcrumbs(currentPath);
          entries = await api.sshWorkspace.listDirectory(hostId, target);
        }
        if (run !== listing) return;
        status.textContent = entries.length === 0 ? "No subfolders here \u2014 open this folder or go up." : "";
        for (const entry of entries) {
          const row = el(
            "button",
            {
              type: "button",
              class: "remote-folder-entry",
              role: "option"
            },
            entry.name
          );
          row.addEventListener("click", () => {
            void browse(entry.path);
          });
          list.append(row);
        }
        upBtn.disabled = currentPath === "/";
        openBtn.disabled = false;
      } catch (err) {
        if (run !== listing) return;
        currentPath = target;
        renderBreadcrumbs(currentPath);
        setInlineStatus(status, "error", ipcErrorMessage(err, "Could not reach the host."));
      } finally {
        if (run === listing) {
          loading = false;
          if (hosts.length > 0 && currentHostId) {
            upBtn.disabled = currentPath === "/";
            openBtn.disabled = false;
          }
        }
      }
    }
    hostSelect.addEventListener("change", () => {
      const value = hostSelect.value;
      if (value.startsWith(SSH_CONFIG_OPTION)) {
        void chooseConfigHost(value.slice(SSH_CONFIG_OPTION.length));
        return;
      }
      currentHostId = value;
      void browseStart();
    });
    upBtn.addEventListener("click", () => {
      void browse(parentRemotePath(currentPath));
    });
    openBtn.addEventListener("click", () => {
      if (!currentHostId) return;
      finish({ hostId: currentHostId, path: currentPath });
    });
    void isSshWorkspaceEnabled(api).then((enabled) => {
      if (enabled) {
        void loadHosts();
        return;
      }
      picker.hidden = true;
      const consent = createSshWorkspaceConsent(api, {
        onEnabled: async () => {
          consent.root.remove();
          picker.hidden = false;
          await loadHosts();
        },
        onCancel: () => {
          finish(null);
        }
      });
      dialog.append(consent.root);
    });
    dialog.showModal();
  });
}
var SSH_CONFIG_OPTION, ensureDialog;
var init_remote_folder_dialog = __esm({
  "src/renderer/views/remote-folder-dialog.ts"() {
    init_dialog_shell();
    init_helpers();
    init_toast();
    init_ssh_host_helpers();
    init_ssh_host_fields();
    init_ssh_workspace_consent();
    init_ssh_workspace_ui();
    init_remote_folder_path();
    init_icons();
    init_inline_status();
    init_ipc_error_message();
    SSH_CONFIG_OPTION = "ssh-config:";
    ensureDialog = lazyBodyDialog("remote-folder-dialog", "remote-folder-dialog");
  }
});
init_remote_folder_dialog();
export {
  openRemoteFolderDialog
};
