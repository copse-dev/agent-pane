import type { SettingField } from './fields.ts'

export const mcpMarkup = `
          <section class="settings-section" data-section="mcp">
            <h3>MCP servers</h3>
            <p class="settings-section-desc">
              Model Context Protocol servers expose external tools to the agent. This section is
              the whole picture of what Copse talks to over MCP, servers you configured, servers
              the open project asks for, and servers your plugins bring with them. Each row says
              where it came from. Configure your own in <code>.cursor/mcp.json</code> (project),
              <code>.mcp.json</code> (project), or <code>~/.cursor/mcp.json</code> (global), then
              reload. Plugins are installed and turned on under Customise.
            </p>

            <fieldset>
              <legend>Connected servers</legend>
              <div id="mcp-server-list" class="mcp-server-list">No servers loaded.</div>
              <p class="field-hint">
                Use the switch on each server to turn it off without editing your MCP config files.
                Off servers are not started on reload.
              </p>
              <div class="settings-action-row">
                <button type="button" class="ui-btn ui-btn-secondary" id="mcp-reload-btn">
                  Reload servers
                </button>
                <span class="lmstudio-test-status" id="mcp-reload-status"></span>
              </div>
            </fieldset>

            <fieldset id="mcp-declared-fieldset" hidden>
              <legend>Declared by plugins, not running</legend>
              <p class="settings-fieldset-desc">
                Plugins you have installed name these servers. Copse is not connected to any of
                them, either the plugin is turned off, or it declares servers Copse does not start
                yet. They are listed so this section stays a complete account of what could reach
                out.
              </p>
              <div id="mcp-declared-list" class="mcp-declared-list"></div>
            </fieldset>

            <fieldset>
              <legend>Copse reviewed servers</legend>
              <p class="settings-fieldset-desc">
                A small catalogue of MCP servers we have checked over. They are off by default:
                flip a switch to add one, with no config files to edit.
              </p>
              <div id="mcp-curated-list" class="mcp-curated-list">Loading…</div>
            </fieldset>

            <fieldset>
              <legend>Tool approval</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="mcpAutoAllowReadOnly" />
                Auto-run MCP tools the server flags as read-only
              </label>
              <p class="field-hint">
                Destructive tools always prompt. Other tools prompt once; choose “always allow” to
                remember a specific tool.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="defaultReadonlyMode" />
                Read-only agent mode
              </label>
              <p class="field-hint">
                Agent runs can read and search the workspace but cannot write files, run shell
                commands, or make network calls. MCP tools are limited to those the server flags as
                read-only and non-destructive (which still prompt as usual).
              </p>
            </fieldset>
          </section>
`

export const mcpFields: readonly SettingField[] = [
  { name: 'mcpAutoAllowReadOnly', kind: 'checkbox', default: false, save: false },
  { name: 'defaultReadonlyMode', kind: 'checkbox', default: false, save: false },
]
