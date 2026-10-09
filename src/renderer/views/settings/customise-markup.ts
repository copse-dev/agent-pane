import { skillsSourcesMarkup } from '../settings-sources-skills.ts'
import type { SettingField } from './fields.ts'

export const customiseMarkup = `
          <section class="settings-section" data-section="customise">
            <h3>Customise</h3>
            <p class="settings-section-desc">
              Everything Copse loads for this project, and every plugin extending it. The loaded
              lists are read-only: edit the files themselves to change what is loaded.
            </p>
            <div class="settings-action-row">
              <button type="button" class="ui-btn ui-btn-secondary" id="sources-reload-btn">
                Reload
              </button>
              <span class="lmstudio-test-status" id="sources-reload-status"></span>
            </div>

            <fieldset>
              <legend>Instruction files</legend>
              <p class="settings-fieldset-desc">
                Files available to the system prompt, in precedence order. Global steering
                (<code>~/AGENTS.md</code>, <code>~/.claude/CLAUDE.md</code>) loads first, then
                project <code>AGENT.md</code>/<code>AGENTS.md</code> (cross-tool),
                <code>CLAUDE.md</code> (Claude Code), directory-scoped nested
                <code>AGENTS.md</code>, and always-applied Cursor rules
                (<code>.cursor/rules/*.mdc</code> with <code>alwaysApply: true</code>, plus
                <code>.cursorrules</code>). Auto-attached and manually <code>@</code>-mentioned
                rules also join this list for the turn that activates them. Nested
                <code>AGENT.md</code> and <code>CLAUDE.md</code> remain root-only compatibility
                formats.
              </p>
              <div id="sources-instructions-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset id="cursor-rules-fieldset" hidden>
              <legend>Cursor rules</legend>
              <p class="settings-fieldset-desc">
                Project rules under <code>.cursor/rules/*.mdc</code> (and legacy
                <code>.cursorrules</code>), classified by activation: always, auto (globs),
                agent (chosen by description), or manual
                (<code>@</code>-mention).
              </p>
              <div id="sources-cursor-rules-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset>
              <legend>Agents</legend>
              <p class="settings-fieldset-desc">
                Subagent definitions found in <code>agents/</code> folders under
                <code>.copse</code>, <code>.cursor</code>, and <code>.claude</code>, in this
                project and in your home directory. Hover a row to see its path. Project agents
                are only read once you trust the project.
              </p>
              <div id="sources-agents-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            ${skillsSourcesMarkup}

            <fieldset data-developer-only="hooks" hidden>
              <legend>Hooks</legend>
              <p class="settings-fieldset-desc">
                Cursor hooks from <code>~/.cursor/hooks.json</code> and Claude Code hooks from
                <code>~/.claude/settings.json</code> (user). When the workspace is trusted, also
                <code>.cursor/hooks.json</code> and <code>.claude/settings.json</code> (project).
                Permission hooks can block or gate the agent's tool calls.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="cursorHooksEnabled" />
                Run external hooks
              </label>
              <p class="field-hint">
                Off by default. Turning this on runs your own scripts while the agent works: every
                tool call it makes can start a matching hook command, with the same rights you
                have on this machine. Project hooks also need you to trust the project, the same
                bar as running its build scripts. A failed blocking hook stops the affected
                action. If a hook breaks, turn hooks off here; notification hooks cannot block
                work that already completed.
              </p>
              <div id="sources-hooks-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset id="plugins-fieldset">
              <legend>Plugins</legend>
              <p class="settings-fieldset-desc">
                Browse available packages or manage every plugin Copse already knows about — shipped with the app,
                added to <code>~/.copse/plugins/</code>, selected as a folder, or installed through
                Cursor. Each row says where it came from and what it contributes. Turning one off
                drops all of its contributions from new work in one action; its stored data and old
                conversation history remain available. Cursor-installed plugins are read-only here
                because Cursor owns their lifecycle. See
                <a href="https://github.com/copse-dev/agent-pane/blob/main/docs/adding-a-plugin.md" target="_blank" rel="noopener noreferrer">how to add a plugin</a>
                for authoring and install steps.
              </p>
              <div class="plugin-view-tabs" role="tablist" aria-label="Plugin collection">
                <button type="button" class="plugin-view-tab active" id="plugins-installed-tab" role="tab" aria-selected="true" aria-controls="plugins-installed-panel">
                  Installed
                </button>
                <button type="button" class="plugin-view-tab" id="plugins-browse-tab" role="tab" aria-selected="false" aria-controls="plugins-browse-panel">
                  Browse
                </button>
              </div>
              <div id="plugins-installed-panel" role="tabpanel" aria-labelledby="plugins-installed-tab">
                <div class="settings-action-row">
                  <button type="button" class="ui-btn ui-btn-secondary" id="plugins-add-btn">
                    Add plugin…
                  </button>
                  <button type="button" class="ui-btn ui-btn-secondary" id="plugins-reload-btn">
                    Reload
                  </button>
                  <span class="lmstudio-test-status plugins-load-status" id="plugins-reload-status"></span>
                </div>
                <div id="plugins-list" class="plugins-group">
                  <span class="plugins-empty">Loading…</span>
                </div>
              </div>
              <div id="plugins-browse-panel" role="tabpanel" aria-labelledby="plugins-browse-tab" hidden></div>
            </fieldset>

          </section>
`

export const customiseFields: readonly SettingField[] = [
  { name: 'cursorHooksEnabled', kind: 'checkbox', default: false, save: false },
]
