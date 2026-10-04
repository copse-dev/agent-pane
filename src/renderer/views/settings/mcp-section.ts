import type { ApiClient } from '../../../preload/api.d.ts'
import type { McpServerStatus } from '@shared/types/mcp.ts'
import { ipcErrorMessage } from '../../ipc-error-message.ts'
import { errorMessage } from '@shared/errors.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { warningIcon } from '../../dom/icons.ts'
import { inlineStatus, setInlineStatus } from '../../dom/inline-status.ts'

export interface McpSection {
  render(statuses: McpServerStatus[]): void
  refresh(): Promise<void>
  refreshCurated(): Promise<void>
  refreshDeclared(): Promise<void>
  invalidate(): void
}
export function createMcpSection(
  overlay: HTMLElement,
  api: ApiClient,
  onTrusted: (statuses: McpServerStatus[]) => void,
  onManagePermissions: () => void,
): McpSection {
  let generation = 0
  /**
   * The origin chip: who asked for this server.
   *
   * A user scanning this list is deciding what the app is allowed to reach, and
   * the answer depends far more on *who declared it* than on whether it is
   * currently connected — a server a cloned repo supplied and one the user
   * wrote into their own config warrant different scrutiny even when both read
   * "connected". The full source path goes in the tooltip rather than the chip,
   * because a home-directory path is long enough to bury the one word that
   * matters.
   */
  function mcpOriginChip(s: import('@shared/types/mcp.ts').McpServerStatus): HTMLElement {
    const labels: Record<import('@shared/types/mcp.ts').McpServerOrigin, string> = {
      user: 'Your config',
      project: 'This project',
      plugin: 'Plugin',
      curated: 'Copse reviewed',
      'built-in': 'Built in',
    }
    const chip = document.createElement('span')
    // A plugin's id is an identifier, shown as written rather than sentence-cased.
    const pluginId = s.origin === 'plugin' && s.originDetail ? s.originDetail : undefined
    chip.className = pluginId
      ? `ui-badge ui-badge-literal mcp-origin-chip mcp-origin-${s.origin}`
      : `ui-badge mcp-origin-chip mcp-origin-${s.origin}`
    chip.dataset['mcpOrigin'] = s.origin
    chip.textContent = pluginId ?? labels[s.origin]
    chip.title = s.originDetail ? `${labels[s.origin]} — ${s.originDetail}` : labels[s.origin]
    return chip
  }

  /**
   * Render the Plugins list, then bring the deep-linked plugin's detail into view:
   * its settings fold is closed by default, so a link that only scrolled would
   * land on a card with the thing it linked to still folded away. The detail
   * itself opens the linked row (see `createAutomationPluginSettings`).
   */
  // Servers whose browser sign-in is in flight, and the last sign-in failure per
  // server. Both outlive a re-render of the list.
  const mcpSignInPending = new Set<string>()
  const mcpSignInErrors = new Map<string, string>()

  function mcpSignInButton(
    s: import('@shared/types/mcp.ts').McpServerStatus,
  ): HTMLButtonElement | null {
    if (s.auth === undefined) return null
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ui-btn ui-btn-compact mcp-auth-btn'
    if (mcpSignInPending.has(s.name)) {
      button.classList.add('ui-btn-secondary')
      button.textContent = 'Cancel sign-in'
      button.addEventListener('click', () => {
        void api.mcp.cancelSignIn(s.name)
      })
      return button
    }
    if (s.auth === 'signed-in') {
      button.classList.add('ui-btn-secondary')
      button.textContent = 'Sign out'
      button.setAttribute('aria-label', `Sign out of ${s.name}`)
      button.addEventListener('click', () => {
        button.disabled = true
        mcpSignInErrors.delete(s.name)
        void api.mcp
          .signOut(s.name)
          .then(renderMcpServers)
          .catch((error: unknown) => {
            mcpSignInErrors.set(s.name, ipcErrorMessage(error, 'Sign-out failed.'))
            void refreshMcpServers()
          })
      })
      return button
    }
    button.classList.add('ui-btn-primary')
    button.textContent = 'Sign in'
    button.setAttribute('aria-label', `Sign in to ${s.name}`)
    button.addEventListener('click', () => {
      mcpSignInPending.add(s.name)
      mcpSignInErrors.delete(s.name)
      void refreshMcpServers()
      void api.mcp
        .signIn(s.name)
        .then((next) => {
          mcpSignInPending.delete(s.name)
          renderMcpServers(next)
        })
        .catch((error: unknown) => {
          mcpSignInPending.delete(s.name)
          const message = ipcErrorMessage(error, 'Sign-in failed.')
          if (message !== 'Sign-in cancelled.') mcpSignInErrors.set(s.name, message)
          void refreshMcpServers()
        })
    })
    return button
  }

  function renderMcpServers(allStatuses: import('@shared/types/mcp.ts').McpServerStatus[]): void {
    const listEl = qsRequired(overlay, '#mcp-server-list')
    // Curated ("Copse reviewed") servers have their own section below.
    const statuses = allStatuses.filter((s) => !s.curated)
    if (statuses.length === 0) {
      listEl.textContent = 'No servers configured.'
      return
    }
    listEl.innerHTML = ''

    // Project-defined servers in an untrusted workspace are not spawned (#100).
    // Offer an explicit "trust this workspace" action before any are started.
    if (statuses.some((s) => s.state === 'untrusted')) {
      const banner = document.createElement('div')
      banner.className = 'mcp-trust-banner'
      const text = document.createElement('span')
      text.textContent =
        'This workspace defines its own MCP servers. They will not run until you trust this workspace.'
      // Trusting also activates the workspace's instruction files (AGENTS.md,
      // Cursor rules) — say so at the consent moment, not only in Sources.
      void api.instructions
        .list()
        .then((files) => {
          const inert = files.filter((f) => !f.active)
          if (inert.length === 0) return
          const note = document.createElement('span')
          note.className = 'mcp-trust-instructions-note'
          note.textContent =
            ` It also ships agent instruction files (${inert.map((f) => f.name).join(', ')}), ` +
            'inert until trusted.'
          text.append(note)
        })
        .catch(() => {
          /* display-only */
        })
      const trustBtn = document.createElement('button')
      trustBtn.type = 'button'
      trustBtn.textContent = 'Trust this workspace'
      trustBtn.addEventListener('click', () => {
        trustBtn.disabled = true
        void api.workspace
          .setTrusted(true)
          .then((next) => {
            // Sources is listing the same workspace's now-loaded instruction
            // files, so it re-renders with the MCP list rather than staying
            // stale until the dialog is reopened.
            onTrusted(next)
          })
          .catch(() => {
            trustBtn.disabled = false
          })
      })
      banner.append(text, trustBtn)
      listEl.append(banner)
      // Decision 7 / F3: the `sandbox: false` escape is surfaced at the consent
      // moment. If this (untrusted) workspace's .copse/hooks.json declares hooks
      // that opt out of the project sandbox, say so *before* the user trusts —
      // trusting is what lets those repo-supplied scripts run unsandboxed.
      void api.workspace
        .unsandboxedProjectHooks()
        .then((unsandboxed) => {
          if (unsandboxed.length === 0) return
          const warn = document.createElement('div')
          warn.className = 'mcp-trust-banner trust-unsandboxed-hooks-warning'
          const label = document.createElement('span')
          const plural = unsandboxed.length === 1 ? 'hook' : 'hooks'
          label.textContent =
            `This workspace declares ${String(unsandboxed.length)} ${plural} with ` +
            `"sandbox": false in .copse/hooks.json. Trusting this workspace allows ` +
            `${unsandboxed.length === 1 ? 'it' : 'them'} to run OUTSIDE the project sandbox:`
          const list = document.createElement('ul')
          for (const h of unsandboxed) {
            const li = document.createElement('li')
            li.textContent = `${h.event}: ${h.command}`
            list.append(li)
          }
          const content = document.createElement('div')
          content.append(label, list)
          warn.append(warningIcon('ui-icon ui-icon-sm'), content)
          banner.after(warn)
        })
        .catch(() => {
          /* display-only; a parse error never blocks the trust flow */
        })
    }

    for (const s of statuses) {
      const badge: Node =
        s.state === 'connected'
          ? inlineStatus('filled', 'connected')
          : s.auth === 'required'
            ? inlineStatus('warn', 'sign-in required')
            : s.state === 'error'
              ? inlineStatus('error', 'error')
              : s.state === 'disabled'
                ? inlineStatus('idle', 'disabled')
                : s.state === 'untrusted'
                  ? inlineStatus('warn', 'not trusted')
                  : document.createTextNode('… connecting')
      const row = document.createElement('div')
      row.className = `mcp-server-row mcp-state-${s.state}`

      const header = document.createElement('div')
      header.className = 'mcp-server-header'

      const toggleLabel = document.createElement('label')
      toggleLabel.className = 'toggle-switch mcp-server-toggle'
      toggleLabel.title = s.configDisabled
        ? 'This server is disabled in your MCP config file'
        : s.userEnabled
          ? 'Turn off this MCP server'
          : 'Turn on this MCP server'
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.checked = s.userEnabled && !s.configDisabled && s.state !== 'untrusted'
      toggle.disabled = s.configDisabled || s.state === 'untrusted'
      toggle.setAttribute('aria-label', `${s.name} MCP server enabled`)
      const track = document.createElement('span')
      track.className = 'toggle-switch-track'
      track.setAttribute('aria-hidden', 'true')
      toggle.addEventListener('change', () => {
        toggle.disabled = true
        void api.mcp
          .setEnabled(s.name, toggle.checked)
          .then((next) => {
            renderMcpServers(next)
          })
          .catch(() => {
            toggle.checked = !toggle.checked
          })
          .finally(() => {
            if (!s.configDisabled && s.state !== 'untrusted') toggle.disabled = false
          })
      })
      toggleLabel.append(toggle, track)

      const title = document.createElement('div')
      title.className = 'mcp-server-summary'
      title.append(`${s.name} (${s.transport}) `, badge)

      header.append(toggleLabel, title, mcpOriginChip(s))
      const permissionsButton = document.createElement('button')
      permissionsButton.type = 'button'
      permissionsButton.className = 'ui-btn ui-btn-secondary mcp-permissions-btn'
      permissionsButton.textContent = 'Manage permissions'
      permissionsButton.setAttribute('aria-label', `Manage permissions for ${s.name}`)
      permissionsButton.addEventListener('click', () => {
        onManagePermissions()
      })
      const authButton = mcpSignInButton(s)
      if (authButton) header.append(authButton)
      header.append(permissionsButton)
      row.append(header)

      const statusDetail =
        s.state === 'connected'
          ? `${String(s.toolCount)} tool(s)${s.tools.length ? `: ${s.tools.join(', ')}` : ''}`
          : s.auth === 'required'
            ? "Sign in to use this server's tools."
            : (s.error ?? '')
      let detailText = mcpSignInPending.has(s.name)
        ? 'Continue in your browser to finish signing in.'
        : (mcpSignInErrors.get(s.name) ?? statusDetail)
      if (s.configDisabled) {
        detailText = detailText
          ? `${detailText} · disabled in MCP config`
          : 'Disabled in MCP config ("disabled": true)'
      } else if (!s.userEnabled && s.state === 'disabled') {
        detailText = 'Turned off in Settings'
      }
      if (detailText) {
        row.append(
          Object.assign(document.createElement('div'), {
            className: 'mcp-server-detail',
            textContent: detailText,
          }),
        )
      }
      listEl.append(row)
    }
  }

  api.mcp.onStatusChanged((statuses) => {
    renderMcpServers(statuses)
  })

  async function refreshMcpServers(): Promise<void> {
    const request = generation
    try {
      const statuses = await api.mcp.list()
      if (request === generation) renderMcpServers(statuses)
    } catch {
      if (request !== generation) return
      renderMcpServers([])
    }
  }

  /**
   * Plugin-declared servers Copse is not running. Hidden entirely when there are
   * none — an empty "not running" list is noise in the common case, and the
   * fieldset only earns its space when it has something to disclose.
   */
  function renderDeclaredMcpServers(
    declared: import('@shared/types/mcp.ts').DeclaredMcpServer[],
  ): void {
    const fieldset = qsRequired(overlay, '#mcp-declared-fieldset')
    const listEl = qsRequired(overlay, '#mcp-declared-list')
    fieldset.hidden = declared.length === 0
    listEl.innerHTML = ''

    for (const s of declared) {
      const row = document.createElement('div')
      row.className = 'mcp-server-row mcp-declared-row'
      row.dataset['mcpServer'] = s.name
      row.dataset['pluginId'] = s.pluginId

      const header = document.createElement('div')
      header.className = 'mcp-server-header'
      const title = document.createElement('div')
      title.className = 'mcp-server-summary'
      title.append(`${s.name} (${s.transport}) `, inlineStatus('idle', 'not running'))

      const chip = document.createElement('span')
      chip.className = 'ui-badge ui-badge-literal mcp-origin-chip mcp-origin-plugin'
      chip.dataset['mcpOrigin'] = 'plugin'
      chip.textContent = s.pluginId
      chip.title = `Declared by the plugin ${s.pluginId}`

      header.append(title, chip)
      row.append(
        header,
        Object.assign(document.createElement('div'), {
          className: 'mcp-server-detail',
          textContent: s.reason,
        }),
      )
      listEl.append(row)
    }
  }

  async function refreshDeclaredMcpServers(): Promise<void> {
    const request = generation
    try {
      const statuses = await api.mcp.listDeclared()
      if (request === generation) renderDeclaredMcpServers(statuses)
    } catch {
      if (request !== generation) return
      renderDeclaredMcpServers([])
    }
  }

  function renderCuratedServers(
    servers: import('@shared/types/mcp.ts').CuratedMcpServerStatus[],
  ): void {
    const listEl = qsRequired(overlay, '#mcp-curated-list')
    listEl.innerHTML = ''
    if (servers.length === 0) {
      listEl.textContent = 'No reviewed servers available.'
      return
    }

    for (const s of servers) {
      const row = document.createElement('div')
      row.className = `mcp-curated-row mcp-state-${s.state}`

      const toggleLabel = document.createElement('label')
      toggleLabel.className = 'toggle-switch mcp-server-toggle'
      toggleLabel.title = s.enabled ? `Turn off ${s.title}` : `Turn on ${s.title}`
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.checked = s.enabled
      toggle.setAttribute('aria-label', `${s.title} enabled`)
      const track = document.createElement('span')
      track.className = 'toggle-switch-track'
      track.setAttribute('aria-hidden', 'true')
      toggle.addEventListener('change', () => {
        toggle.disabled = true
        void api.mcp
          .setCuratedEnabled(s.name, toggle.checked)
          .then((next) => {
            renderCuratedServers(next)
          })
          .catch(() => {
            toggle.checked = !toggle.checked
            toggle.disabled = false
          })
      })
      toggleLabel.append(toggle, track)

      const body = document.createElement('div')
      body.className = 'mcp-curated-body'

      const titleRow = document.createElement('div')
      titleRow.className = 'mcp-curated-title'
      const name = document.createElement('span')
      name.textContent = s.title
      const link = document.createElement('a')
      link.href = '#'
      link.className = 'mcp-curated-link'
      link.textContent = 'Learn more'
      link.addEventListener('click', (e) => {
        e.preventDefault()
        void api.shell.openExternal(s.homepage)
      })
      titleRow.append(name, link)

      const desc = document.createElement('div')
      desc.className = 'mcp-curated-desc'
      desc.textContent = s.description

      body.append(titleRow, desc)

      // Surface the live connection state once enabled.
      if (s.enabled) {
        const status = document.createElement('div')
        status.className = 'mcp-curated-status'
        if (s.state === 'connected') {
          setInlineStatus(
            status,
            'filled',
            `connected, ${String(s.toolCount)} tool(s)${s.tools.length ? `: ${s.tools.join(', ')}` : ''}`,
          )
        } else if (s.state === 'error') {
          setInlineStatus(status, 'error', s.error ?? 'error')
        } else {
          status.textContent = '… connecting'
        }
        body.append(status)
      }

      row.append(toggleLabel, body)
      listEl.append(row)
    }
  }

  async function refreshCuratedServers(): Promise<void> {
    const request = generation
    try {
      const statuses = await api.mcp.listCurated()
      if (request === generation) renderCuratedServers(statuses)
    } catch {
      if (request !== generation) return
      renderCuratedServers([])
    }
  }

  qsRequired(overlay, '#mcp-reload-btn').addEventListener('click', () => {
    const request = generation
    const statusEl = qsRequired(overlay, '#mcp-reload-status')
    statusEl.textContent = 'Reloading…'
    statusEl.className = 'lmstudio-test-status'
    void api.mcp
      .reload()
      .then((statuses) => {
        if (request !== generation) return
        renderMcpServers(statuses)
        void refreshCuratedServers()
        void refreshDeclaredMcpServers()
        const visible = statuses.filter((s) => !s.curated)
        const ok = visible.filter((s) => s.state === 'connected').length
        setInlineStatus(
          statusEl,
          'ok',
          `${String(ok)}/${String(visible.length)} server(s) connected`,
        )
        statusEl.classList.add('ok')
      })
      .catch((err: unknown) => {
        if (request !== generation) return
        setInlineStatus(statusEl, 'error', errorMessage(err))
        statusEl.classList.add('err')
      })
  })

  return {
    render: renderMcpServers,
    refresh: refreshMcpServers,
    refreshCurated: refreshCuratedServers,
    refreshDeclared: refreshDeclaredMcpServers,
    invalidate: (): void => {
      generation += 1
    },
  }
}
