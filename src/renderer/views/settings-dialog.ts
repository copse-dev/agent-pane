import { errorMessage } from '@shared/errors.ts'
import type { AppStore } from '@shared/store/store.ts'
import { isRightPanelPosition } from '@shared/types/state.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  APP_ICON_VARIANTS,
  APP_ICON_VARIANT_LABELS,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
  type AppIconVariant,
} from '@shared/app-icon-variants.ts'
import { DEFAULT_CLOUD_MODEL } from '@shared/llm/model-catalog.ts'
import { DEFAULT_ADVISOR_MODEL } from '../../main/services/advisor-strategy.ts'
import { qsRequired } from '../dom/helpers.ts'
import { populateModelSelect, populateSmallTasksModelSelect } from './model-options.ts'
import { createApiKeysSection } from './setup/api-keys-section.ts'
import { createCustomProvidersSection } from './setup/custom-providers-section.ts'
import { createAcpAgentsSection } from './setup/acp-agents-section.ts'
import { createEnvKeyDetectSection } from './setup/env-key-detect-section.ts'
import { createLmStudioSection } from './setup/lm-studio-section.ts'
import { createGhCliSection } from './setup/gh-cli-section.ts'
import { createModelRoutingSection } from './setup/model-routing-section.ts'
import { createUsageSection } from './setup/usage-section.ts'
import {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  WEB_ALLOWED_ORIGINS_SETTING,
  WEB_ALLOW_USER_APPROVAL_SETTING,
} from '@shared/web-origins.ts'

type SettingsSection = 'general' | 'usage' | 'local-models' | 'mcp' | 'appearance' | 'experimental'

/**
 * Single source of truth for the simple form fields, so each setting's default
 * is declared once instead of being duplicated across the load and save handlers
 * (an open default-drift bug class). Fields needing bespoke wiring (model select,
 * theme/fontSize from the store, app icon radios, the LM Studio security bundle
 * saved via `setSecurity`) stay hand-coded below.
 *
 * `kind: 'checkbox'` reads/writes `.checked`; `'text'` reads/writes `.value`.
 * `save: true` means the field round-trips through `api.settings.set(name, …)`
 * symmetrically; security-bundle fields set `save: false` (loaded here, saved by
 * the `setSecurity` call) so their defaults are still declared in one place.
 */
interface SettingField {
  name: string
  kind: 'checkbox' | 'text'
  default: boolean | string
  /** Whether the save handler writes this field via api.settings.set. */
  save: boolean
}

const SIMPLE_FIELDS: readonly SettingField[] = [
  { name: 'customInstructions', kind: 'text', default: '', save: true },
  { name: 'openRouterModel', kind: 'text', default: '', save: true },
  { name: 'externalApiSafety', kind: 'checkbox', default: false, save: true },
  { name: 'remoteAgentRepository', kind: 'text', default: '', save: true },
  { name: 'remoteAgentStartingRef', kind: 'text', default: '', save: true },
  { name: 'remoteAgentAutoCreatePR', kind: 'checkbox', default: true, save: true },
  { name: 'remoteAgentWorkOnCurrentBranch', kind: 'checkbox', default: false, save: true },
  { name: 'localSubagentsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'localTodoItemsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'postTurnReviewEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'bundledCursorSkillsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'skillExternalLinkWarnings', kind: 'checkbox', default: true, save: true },
  { name: 'skillSandboxGuidance', kind: 'checkbox', default: true, save: true },
  // Built-in browser tools (Electron's bundled Chromium); on by default so the
  // agent renders/screenshots web UIs in-app instead of installing a browser.
  { name: 'browserToolsEnabled', kind: 'checkbox', default: true, save: true },
  // Experimental, opt-in features (off by default).
  { name: 'mcpUiArtefactsEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'ciInvestigatorEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'okfMemoriesEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'longHorizonTasksEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'modelClassifierEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'advisorStrategyEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'roadmapPlansEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'piiRedactionEnabled', kind: 'checkbox', default: false, save: true },
  // Loaded here; saved as part of the setSecurity() bundle below.
  { name: 'safetyClassifierEnabled', kind: 'checkbox', default: true, save: false },
  { name: 'autoRunSandboxCommands', kind: 'checkbox', default: true, save: false },
  { name: 'mcpAutoAllowReadOnly', kind: 'checkbox', default: false, save: false },
  { name: 'defaultReadonlyMode', kind: 'checkbox', default: false, save: false },
  { name: 'webAllowUserApproval', kind: 'checkbox', default: true, save: false },
  { name: 'safetyConfidenceThreshold', kind: 'text', default: '0.85', save: false },
]

async function loadSimpleFields(form: HTMLFormElement, api: ApiClient): Promise<void> {
  for (const field of SIMPLE_FIELDS) {
    const input = form.elements.namedItem(field.name) as HTMLInputElement | HTMLTextAreaElement
    const saved = await api.settings.get(field.name)
    if (field.kind === 'checkbox') {
      ;(input as HTMLInputElement).checked =
        (saved as boolean | undefined) ?? (field.default as boolean)
    } else {
      input.value =
        typeof saved === 'string' || typeof saved === 'number'
          ? String(saved)
          : String(field.default)
    }
  }
}

async function saveSimpleFields(data: FormData, api: ApiClient): Promise<void> {
  for (const field of SIMPLE_FIELDS) {
    if (!field.save) continue
    if (field.kind === 'checkbox') {
      await api.settings.set(field.name, data.get(field.name) === 'on')
    } else {
      const value = (data.get(field.name) as string | null) ?? ''
      const trimmed = field.name === 'customInstructions' || field.name === 'openRouterModel'
      await api.settings.set(field.name, trimmed ? value.trim() : value)
    }
  }
}

function parseWebAllowedOrigins(value: FormDataEntryValue | null): string[] {
  const text = typeof value === 'string' ? value : ''
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

let overlayEl: HTMLDialogElement | null = null

export function openSettingsDialog(): void {
  if (!overlayEl || overlayEl.open) return
  // showModal() puts the dialog in the top layer: focus is trapped inside, the
  // background is made inert, and Esc closes it — all for free, replacing the
  // hand-rolled overlay + manual `hidden` toggle.
  overlayEl.showModal()
  overlayEl.dispatchEvent(new Event('settings-open'))
}

export function closeSettingsDialog(): void {
  if (!overlayEl || !overlayEl.open) return
  overlayEl.close()
}

export function isSettingsDialogOpen(): boolean {
  return !!overlayEl && overlayEl.open
}

/**
 * Subscribe to the settings dialog closing (Save, Cancel, the ✕ button, or Esc —
 * all funnel through the native dialog `close` event). Used by other top-layer
 * UI (e.g. the approval dialog) that must stay behind settings: it defers itself
 * while settings is open and flushes when this fires. Returns an unsubscribe fn.
 */
export function onSettingsDialogClose(listener: () => void): () => void {
  if (!overlayEl) throw new Error('onSettingsDialogClose called before mountSettingsDialog')
  overlayEl.addEventListener('close', listener)
  return () => overlayEl?.removeEventListener('close', listener)
}

export function mountSettingsDialog(store: AppStore, api: ApiClient): void {
  // A native <dialog> (opened via showModal in openSettingsDialog) rather than a
  // div: the platform handles focus-trapping, inert background, top-layer
  // stacking, and Esc-to-close. Closed by default — no `hidden` needed.
  const overlay = document.createElement('dialog')
  overlay.id = 'settings-dialog'
  overlay.className = 'settings-overlay'
  overlay.innerHTML = `
    <div class="settings-shell">
      <header class="settings-header">
        <h2>Settings</h2>
        <button type="button" class="settings-close-btn" id="settings-close" aria-label="Close settings">✕</button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          <button type="button" class="settings-nav-btn active" data-section="general">General</button>
          <button type="button" class="settings-nav-btn" data-section="usage">Usage</button>
          <button type="button" class="settings-nav-btn" data-section="local-models">Local models</button>
          <button type="button" class="settings-nav-btn" data-section="mcp">MCP servers</button>
          <button type="button" class="settings-nav-btn" data-section="appearance">Appearance</button>
          <button type="button" class="settings-nav-btn" data-section="experimental">Experimental</button>
        </nav>

        <form class="settings-content">
          <section class="settings-section active" data-section="general">
            <h3>General</h3>
            <p class="settings-section-desc">
              Cloud API keys, default chat model, and task-specific model choices.
            </p>

            <div id="settings-custom-providers-host"></div>

            <div id="settings-env-detect-host"></div>

            <fieldset>
              <legend>Chat model</legend>
              <label>
                Default model
                <select name="model"></select>
              </label>
              <span class="field-hint">
                Pick a cloud, local, or remote-agent model here (or from the model picker beside the
                chat box). Selecting <strong>Cursor Cloud Agent</strong> sends each turn to Cursor
                Cloud instead of running it on this machine — configure it below.
              </span>
              <label>
                Custom OpenRouter model
                <input
                  type="text"
                  name="openRouterModel"
                  placeholder="vendor/model (e.g. anthropic/claude-3.7-sonnet)"
                  autocomplete="off"
                />
                <span class="field-hint">
                  Adds a model id beyond the built-in OpenRouter shortlist to the picker. Requires an
                  OpenRouter API key below. Browse ids at <code>openrouter.ai/models</code>.
                </span>
              </label>
            </fieldset>

            <fieldset>
              <legend>Remote agents</legend>
              <p class="settings-fieldset-desc">
                Choose <strong>Cursor Cloud Agent</strong> or <strong>Claude Agent</strong> as your
                model to run chat turns on a remote machine. The conversation streams back here just
                like a normal chat, but the work happens in the cloud: the agent runs its own tools,
                pushes commits to a branch, and (optionally) opens a pull request. It does
                <strong>not</strong> edit the files in this local workspace — review its changes in
                the branch / PR it links in the reply.
              </p>
              <div class="provider-chips" role="tablist" id="settings-remote-agent-tabs"></div>
              <div id="settings-cursor-panel" class="remote-agent-panel">
                <div id="settings-cursor-key-host"></div>
              </div>
              <div id="settings-claude-panel" class="remote-agent-panel" hidden>
                <div id="settings-claude-agent-key-host"></div>
                <p class="field-hint">
                  Claude Agent needs an Anthropic API key plus a GitHub token: the token is used only
                  to clone and push the repository — the agent never handles it directly. It always
                  uses <code>https://api.anthropic.com</code>.
                </p>
              </div>
              <p class="settings-fieldset-desc remote-agent-common-note">
                These apply to whichever remote agent you run:
              </p>
              <label>
                Repository
                <input
                  type="text"
                  name="remoteAgentRepository"
                  placeholder="https://github.com/owner/repo (defaults to project origin)"
                  autocomplete="off"
                />
                <span class="field-hint">
                  Which GitHub repo the remote agent works on. Leave blank to use this project's
                  <code>origin</code> remote.
                </span>
              </label>
              <label>
                Starting ref
                <input
                  type="text"
                  name="remoteAgentStartingRef"
                  placeholder="main (optional)"
                  autocomplete="off"
                />
                <span class="field-hint">Branch or commit the remote agent branches from.</span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="remoteAgentAutoCreatePR" />
                Open a pull request automatically when the remote agent finishes
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="remoteAgentWorkOnCurrentBranch" />
                Push directly to the starting ref instead of a new branch
              </label>
            </fieldset>

            <fieldset>
              <legend>Small tasks</legend>
              <p class="settings-fieldset-desc">
                Lightweight prompts such as thread titles and follow-up suggestions. Use any cloud or
                local model — not limited to LM Studio.
              </p>
              <label>
                Model
                <select name="smallTasksModel"></select>
              </label>
            </fieldset>

            <div id="settings-model-routing-host"></div>

            <div id="settings-gh-cli-host"></div>

            <fieldset>
              <legend>Agent behavior</legend>
              <label>
                Custom instructions
                <textarea
                  name="customInstructions"
                  rows="4"
                  placeholder="Always-on guidance added to every conversation (e.g. preferred style, conventions)."
                ></textarea>
                <span class="field-hint">
                  Appended to the system prompt for every thread. A project <code>AGENT.md</code> adds
                  per-project instructions on top of this.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="externalApiSafety" />
                External-API safety steering
              </label>
              <p class="field-hint">
                Reminds the agent to pick compatible dependency versions and never hardcode or log
                secrets when adding API calls.
              </p>
            </fieldset>

            <fieldset>
              <legend>Skills</legend>
              <p class="settings-fieldset-desc">
                Reusable agent workflows invoked with <code>/skill-name</code> in the chat input.
                Official Cursor skills are fetched at build time (not stored in git); project skills
                live in <code>.cursor/skills/</code>.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="bundledCursorSkillsEnabled" />
                Include bundled Cursor skills (CI, code review, verification, and more)
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="skillExternalLinkWarnings" />
                Warn before running a skill that references external links
              </label>
              <p class="field-hint">
                When an invoked skill's <code>SKILL.md</code> points at <code>http(s)</code> hosts,
                surface a warning up front and tell the agent to treat fetch/install/run-from-network
                steps as approval-gated.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="skillSandboxGuidance" />
                Reinforce sandbox confinement for invoked skills
              </label>
              <p class="field-hint">
                Reminds the agent that a skill's shell commands stay inside the project sandbox (or,
                where no OS sandbox is active, require approval) rather than silently reaching the
                network or the host filesystem.
              </p>
            </fieldset>

            <fieldset>
              <legend>Web access</legend>
              <p class="settings-fieldset-desc">
                Agent web tools are limited to these origins. New origins require approval before
                <code>fetch_url</code> can access them.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="browserToolsEnabled" />
                Built-in browser tools (load &amp; screenshot web UIs in-app)
              </label>
              <p class="field-hint">
                Lets the agent open and inspect pages in the app's bundled browser instead of
                installing a separate browser (e.g. Playwright). Localhost auto-runs; other origins
                prompt.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="webAllowUserApproval" />
                Ask before allowing new web origins
              </label>
              <label>
                Allowed web origins
                <textarea
                  name="webAllowedOrigins"
                  rows="6"
                  spellcheck="false"
                  placeholder="https://example.com"
                ></textarea>
                <span class="field-hint">
                  One per line. Supports exact origins and wildcard subdomains such as
                  <code>https://*.duckduckgo.com</code>. Defaults include localhost and DuckDuckGo.
                </span>
              </label>
            </fieldset>
          </section>

          <section class="settings-section" data-section="usage">
            <h3>Usage</h3>
            <p class="settings-section-desc">
              Estimated cloud spend and local (free) model token usage across all workspaces.
              Costs are approximate and use catalog pricing, including Anthropic prompt-cache rates
              when cache tokens are reported.
            </p>
            <div id="settings-usage-host"></div>
          </section>

          <section class="settings-section" data-section="local-models">
            <h3>Local models</h3>
            <p class="settings-section-desc">
              Connect to an LM Studio (or other OpenAI-compatible) server.
            </p>

            <div id="settings-local-providers-host"></div>

            <fieldset>
              <legend>Routing behavior</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="localSubagentsEnabled" />
                Use local models for exploration subagents when chat uses a cloud model
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="localTodoItemsEnabled" />
                Use local models for todo items tagged local (requires acceptance check)
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="postTurnReviewEnabled" />
                Review the diff with a subagent after each editing turn
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="safetyClassifierEnabled" />
                Use instruct model to classify shell commands (when OS sandbox is off)
              </label>
              <label>
                Safety confidence threshold
                <input
                  type="number"
                  name="safetyConfidenceThreshold"
                  min="0"
                  max="1"
                  step="0.05"
                />
                <span class="field-hint">Auto-allow sandbox-scoped commands at or above this confidence (0–1)</span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="autoRunSandboxCommands" />
                Auto-run shell commands contained within the sandbox
              </label>
            </fieldset>
          </section>

          <section class="settings-section" data-section="mcp">
            <h3>MCP servers</h3>
            <p class="settings-section-desc">
              Model Context Protocol servers expose external tools to the agent. Define them in
              <code>.cursor/mcp.json</code> (project), <code>.mcp.json</code> (project),
              <code>~/.cursor/mcp.json</code> (global), or a Cursor marketplace plugin's
              <code>.mcp.json</code> (via <code>plugin.json</code> <code>mcpServers</code>), then
              reload.
            </p>

            <fieldset>
              <legend>Connected servers</legend>
              <div id="mcp-server-list" class="mcp-server-list">No servers loaded.</div>
              <p class="field-hint">
                Use the switch on each server to turn it off without editing your MCP config files.
                Off servers are not started on reload.
              </p>
              <div class="lmstudio-test-row">
                <button type="button" id="mcp-reload-btn">Reload servers</button>
                <span class="lmstudio-test-status" id="mcp-reload-status"></span>
              </div>
            </fieldset>

            <fieldset>
              <legend>Copse reviewed servers</legend>
              <p class="settings-fieldset-desc">
                A small catalog of MCP servers we've vetted. They're off by default — flip a switch
                to add one to the agent. No config file editing required.
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

          <section class="settings-section" data-section="appearance">
            <h3>Appearance</h3>
            <p class="settings-section-desc">Theme, app icon, editor font size, and window layout.</p>

            <fieldset>
              <legend>Display</legend>
              <label>
                Theme
                <select name="theme">
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label>
                Font size
                <input type="number" name="fontSize" min="12" max="20" step="1" />
              </label>
              <label>
                Right panel position
                <select name="rightPanelPosition">
                  <option value="auto">Automatic</option>
                  <option value="side">Beside chat</option>
                  <option value="bottom">Below chat</option>
                </select>
              </label>
              <p class="field-hint">
                Choose where Explorer, Terminal, Changes, and Plan live. "Below chat" keeps the
                terminal wide and readable on smaller screens.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="autoPortraitRightPanel" />
                Move the right panel below chat on tall portrait windows
              </label>
              <p class="field-hint">
                Only applies when the position above is "Automatic": splits portrait windows
                horizontally so Projects + chat stay above Explorer, Terminal, Changes, and Plan.
              </p>
            </fieldset>

            <fieldset>
              <legend>App icon</legend>
              <p class="settings-fieldset-desc">
                Choose the icon shown in the Dock, taskbar, and window title bar.
              </p>
              <div class="app-icon-picker" role="radiogroup" aria-label="App icon">
                ${APP_ICON_VARIANTS.map(
                  (variant) => `
                <label class="app-icon-option">
                  <input type="radio" name="appIconVariant" value="${variant}" />
                  <span class="app-icon-preview">
                    <img src="./icon-previews/${variant}.png" alt="" width="64" height="64" />
                  </span>
                  <span class="app-icon-label">${APP_ICON_VARIANT_LABELS[variant]}</span>
                </label>`,
                ).join('')}
              </div>
            </fieldset>
          </section>

          <section class="settings-section" data-section="experimental">
            <h3>Experimental</h3>
            <p class="settings-section-desc">
              Early, opt-in features that are still being explored. They may change or be removed,
              and are off by default.
            </p>

            <div id="settings-acp-agents-host"></div>

            <fieldset>
              <legend>MCP UI artefacts (canvas)</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="mcpUiArtefactsEnabled" />
                Render MCP-UI artefacts as a sandboxed canvas
              </label>
              <p class="field-hint">
                When an MCP tool returns a UI resource (self-contained HTML or a URL), Copse
                recognises it and will render it as a fully sandboxed artefact in the Browser pane —
                no Node, no app access. While off, UI resources are treated as plain tool output.
              </p>
            </fieldset>

            <fieldset>
              <legend>CI investigator subagent</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="ciInvestigatorEnabled" />
                Enable the CI investigator subagent
              </label>
              <p class="field-hint">
                Adds an <code>investigate_ci</code> tool that delegates to a read-only subagent to
                analyse failing CI run logs in depth and report the root cause, and points the
                "Investigate CI failure" follow-up at it. While off, CI failures use the plain
                "Debug CI Failure" follow-up and the tool is not registered.
              </p>
            </fieldset>

            <fieldset>
              <legend>Memories (Open Knowledge Format)</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="okfMemoriesEnabled" />
                Let the agent remember and recall project knowledge
              </label>
              <p class="field-hint">
                Adds <code>remember</code> and <code>recall</code> tools so the agent can persist
                durable project knowledge — conventions, decisions, gotchas — across sessions. Notes
                are saved per project as portable
                <a href="https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing" target="_blank" rel="noreferrer">Open Knowledge Format</a>
                markdown files (YAML frontmatter plus a markdown body) under
                <code>~/.copse/memories</code>. While off, neither tool is registered.
              </p>
            </fieldset>

            <fieldset>
              <legend>Long-horizon tasks</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="longHorizonTasksEnabled" />
                Let the agent keep a durable checklist for long grind tasks
              </label>
              <p class="field-hint">
                Adds a <code>track_long_task</code> tool so the agent can keep a durable, resumable
                checklist for a long task within a PR — clearing a lint/type-safety backlog, a deep
                research pass — with done/remaining state that survives across sessions, so it can
                resume from the last checkpoint and know when every step is complete. Tasks are
                stored per project under <code>~/.copse/long-tasks</code>. While off, the tool is not
                registered.
              </p>
            </fieldset>

            <fieldset>
              <legend>Model classifier</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="modelClassifierEnabled" />
                Let the agent get a best-fit model recommendation for a task
              </label>
              <p class="field-hint">
                Adds a <code>suggest_model</code> tool that recommends a capability tier
                (fast / balanced / frontier) and a representative model for a task, so cheap/fast
                models handle trivial work and frontier models are reserved for the hard problems.
                Advisory only — it does not switch the model in use. While off, the tool is not
                registered.
              </p>
            </fieldset>

            <fieldset>
              <legend>Advisor strategy</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="advisorStrategyEnabled" />
                Let the agent consult a larger advisor model mid-task
              </label>
              <p class="field-hint">
                Adds a no-parameter <code>advisor</code> tool that forwards your full conversation
                transcript to a larger advisor model for strategic guidance, so the everyday loop can
                run on a cheaper or on-device model while frontier intelligence is pulled in at the
                moments that matter (planning, getting unstuck, final review). Shaped to match
                Claude’s native advisor tool. While off, the tool is not registered.
              </p>
              <label class="field-label" for="advisorModel">Advisor model</label>
              <select id="advisorModel" name="advisorModel">
                <option value="">(loading…)</option>
              </select>
              <p class="field-hint">
                Model used for advisor consultations. Pick a configured cloud provider; defaults to
                <code>claude-opus-4-8</code>.
              </p>
            </fieldset>

            <fieldset>
              <legend>Roadmap plans</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="roadmapPlansEnabled" />
                Let the agent keep a roadmap of future-work prompts
              </label>
              <p class="field-hint">
                Adds a <code>roadmap_plan</code> tool so the agent can record prompts to run over a
                longer time horizon than the current change and track each item's status
                (ready / blocked / conflicts / done) across sessions — a notes app for future work,
                so longer-horizon plans aren't started before the PRs they depend on merge. Items
                are stored per project under <code>~/.copse/roadmap</code>. While off, the tool is
                not registered.
              </p>
            </fieldset>

            <fieldset>
              <legend>PII redaction (on-device)</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="piiRedactionEnabled" />
                Redact personal data in my messages before they are sent
              </label>
              <p class="field-hint">
                Uses <a href="https://github.com/nationaldesignstudio/rampart" target="_blank" rel="noreferrer">Rampart</a>
                (National Design Studio, CC BY 4.0) to replace personal data you type — names, emails,
                phone numbers, SSNs, card numbers, addresses — with stable placeholders like
                <code>[EMAIL_1]</code> before your message leaves the device for any model provider. The
                real values stay in memory on this machine and never cross the wire. When the agent
                genuinely needs a value it calls <code>reveal_pii</code>, which prompts you to approve
                each reveal. Best-effort and Latin-script only — not a guarantee. The first run downloads
                a small (~15&nbsp;MB) model; while off, nothing is loaded.
              </p>
            </fieldset>
          </section>

          <div class="settings-buttons">
            <button type="submit">Save</button>
            <button type="button" id="settings-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `
  document.body.append(overlay)
  overlayEl = overlay

  // Every `qsRequired(overlay, …)` below targets an element baked into the static
  // template above; a miss throws a loud error (template/code drift) rather than a
  // silent non-null assertion.
  const customProvidersSection = createCustomProvidersSection(api)
  qsRequired(overlay, '#settings-custom-providers-host').append(customProvidersSection.root)

  const acpAgentsSection = createAcpAgentsSection(api)
  qsRequired(overlay, '#settings-acp-agents-host').append(acpAgentsSection.root)

  const envKeyDetectSection = createEnvKeyDetectSection(api, {
    onImported: () => {
      void cursorKeySection.refreshKeyStatus()
      void customProvidersSection.refresh()
    },
  })
  overlay.querySelector('#settings-env-detect-host')?.append(envKeyDetectSection.root)

  const cursorKeySection = createApiKeysSection(api, {
    legend: 'Cursor authentication',
    providers: ['cursor'],
  })
  qsRequired(overlay, '#settings-cursor-key-host').append(cursorKeySection.root)

  // The GitHub token has no validation endpoint, so skip on-input validation for
  // this section (the Anthropic key still shows a saved/not-set status).
  const claudeAgentKeySection = createApiKeysSection(api, {
    legend: 'Claude authentication',
    providers: ['anthropic', 'github'],
    validateOnInput: false,
  })
  qsRequired(overlay, '#settings-claude-agent-key-host').append(claudeAgentKeySection.root)

  // Provider tabs for the Remote agents section: a chip selects one provider and
  // shows just its auth panel (mirrors the Providers chip row). The common run
  // options below the panels apply to whichever remote agent is run.
  const remoteTabsRow = overlay.querySelector('#settings-remote-agent-tabs') as HTMLElement
  const remoteTabs: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'cursor', label: 'Cursor Cloud Agent' },
    { id: 'anthropic', label: 'Claude Agent' },
  ]
  const remotePanels: Record<string, HTMLElement> = {
    cursor: overlay.querySelector('#settings-cursor-panel') as HTMLElement,
    anthropic: overlay.querySelector('#settings-claude-panel') as HTMLElement,
  }
  function showRemoteTab(id: string): void {
    for (const [provider, panel] of Object.entries(remotePanels)) panel.hidden = provider !== id
    remoteTabsRow
      .querySelectorAll<HTMLButtonElement>('.provider-chip')
      .forEach((btn) => btn.classList.toggle('active', btn.dataset['provider'] === id))
  }
  for (const tab of remoteTabs) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'provider-chip'
    chip.setAttribute('role', 'tab')
    chip.dataset['provider'] = tab.id
    chip.textContent = tab.label
    chip.addEventListener('click', () => {
      showRemoteTab(tab.id)
    })
    remoteTabsRow.append(chip)
  }
  showRemoteTab('cursor')

  // Unified Local providers panel: LM Studio leads as a native chip (its bespoke
  // server-connection + recommended-models UI), followed by the OpenAI-compatible
  // local presets (Ollama, llama.cpp, Jan, vLLM) and an add-your-own form. The
  // cloud Providers panel above filters local providers out via the `local` flag
  // so each provider appears in exactly one place. The dialog keeps the LM Studio
  // handle for getUrl()/saveConnection() in the security-bundle save below.
  const lmStudioSection = createLmStudioSection(api, { showInstallGuide: false })
  const localProvidersSection = createCustomProvidersSection(api, {
    variant: 'local',
    nativeProviders: [
      {
        id: 'lmstudio',
        label: 'LM Studio',
        element: lmStudioSection.root,
        refresh: (): Promise<void> => lmStudioSection.refreshDetection(),
      },
    ],
  })
  qsRequired(overlay, '#settings-local-providers-host').append(localProvidersSection.root)

  const ghCliSection = createGhCliSection(api)
  qsRequired(overlay, '#settings-gh-cli-host').append(ghCliSection.root)

  const modelRoutingSection = createModelRoutingSection(api)
  qsRequired(overlay, '#settings-model-routing-host').append(modelRoutingSection.root)

  const usageSection = createUsageSection(api, store)
  qsRequired(overlay, '#settings-usage-host').append(usageSection.root)

  const navBtns = overlay.querySelectorAll<HTMLButtonElement>('.settings-nav-btn')
  const sections = overlay.querySelectorAll<HTMLElement>('.settings-section')

  function showSection(id: SettingsSection): void {
    navBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset['section'] === id))
    sections.forEach((sec) => sec.classList.toggle('active', sec.dataset['section'] === id))
  }

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset['section'] as SettingsSection | undefined
      if (id) {
        showSection(id)
        if (id === 'usage') void usageSection.refresh()
        // Defer the ACP device scan until its tab is opened, so users who never
        // visit Experimental don't trigger a which/ps scan on every settings open.
        if (id === 'experimental') void acpAgentsSection.refresh()
      }
    })
  })

  async function refreshLocalModelSelects(): Promise<void> {
    await modelRoutingSection.refresh()
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
      const trustBtn = document.createElement('button')
      trustBtn.type = 'button'
      trustBtn.textContent = 'Trust this workspace'
      trustBtn.addEventListener('click', () => {
        trustBtn.disabled = true
        void api.workspace
          .setTrusted(true)
          .then((next) => {
            renderMcpServers(next)
          })
          .catch(() => {
            trustBtn.disabled = false
          })
      })
      banner.append(text, trustBtn)
      listEl.append(banner)
    }

    for (const s of statuses) {
      const badge =
        s.state === 'connected'
          ? '● connected'
          : s.state === 'error'
            ? '✗ error'
            : s.state === 'disabled'
              ? '○ disabled'
              : s.state === 'untrusted'
                ? '⚠ not trusted'
                : '… connecting'
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
      title.textContent = `${s.name} (${s.transport}) — ${badge}`

      header.append(toggleLabel, title)
      row.append(header)

      let detailText =
        s.state === 'connected'
          ? `${String(s.toolCount)} tool(s)${s.tools.length ? `: ${s.tools.join(', ')}` : ''}`
          : (s.error ?? '')
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

  async function refreshMcpServers(): Promise<void> {
    try {
      renderMcpServers(await api.mcp.list())
    } catch {
      renderMcpServers([])
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
        status.textContent =
          s.state === 'connected'
            ? `● connected — ${String(s.toolCount)} tool(s)${s.tools.length ? `: ${s.tools.join(', ')}` : ''}`
            : s.state === 'error'
              ? `✗ ${s.error ?? 'error'}`
              : '… connecting'
        body.append(status)
      }

      row.append(toggleLabel, body)
      listEl.append(row)
    }
  }

  async function refreshCuratedServers(): Promise<void> {
    try {
      renderCuratedServers(await api.mcp.listCurated())
    } catch {
      renderCuratedServers([])
    }
  }

  qsRequired(overlay, '#mcp-reload-btn').addEventListener('click', () => {
    const statusEl = qsRequired(overlay, '#mcp-reload-status')
    statusEl.textContent = 'Reloading…'
    statusEl.className = 'lmstudio-test-status'
    void api.mcp
      .reload()
      .then((statuses) => {
        renderMcpServers(statuses)
        void refreshCuratedServers()
        const visible = statuses.filter((s) => !s.curated)
        const ok = visible.filter((s) => s.state === 'connected').length
        statusEl.textContent = `✓ ${String(ok)}/${String(visible.length)} server(s) connected`
        statusEl.classList.add('ok')
      })
      .catch((err: unknown) => {
        statusEl.textContent = `✗ ${errorMessage(err)}`
        statusEl.classList.add('err')
      })
  })

  overlay.addEventListener('settings-open', () => {
    showSection('general')
    void (async (): Promise<void> => {
      await cursorKeySection.refreshKeyStatus()
      await claudeAgentKeySection.refreshKeyStatus()
      await customProvidersSection.refresh()
      await envKeyDetectSection.refresh()
      await localProvidersSection.refresh()

      const form = qsRequired<HTMLFormElement>(overlay, 'form')
      const model = (await api.settings.get('model')) as string | undefined
      await populateModelSelect(
        form.elements.namedItem('model') as HTMLSelectElement,
        api,
        model ?? DEFAULT_CLOUD_MODEL,
      )
      const smallTasksModel = (await api.settings.get('smallTasksModel')) as string | undefined
      await populateSmallTasksModelSelect(
        form.elements.namedItem('smallTasksModel') as HTMLSelectElement,
        api,
        smallTasksModel ?? '',
      )
      const advisorModel = (await api.settings.get('advisorModel')) as string | undefined
      await populateModelSelect(
        form.elements.namedItem('advisorModel') as HTMLSelectElement,
        api,
        advisorModel ?? DEFAULT_ADVISOR_MODEL,
      )
      await loadSimpleFields(form, api)
      const savedWebOrigins = (await api.settings.get(WEB_ALLOWED_ORIGINS_SETTING)) as
        | string[]
        | undefined
        | null
      ;(form.elements.namedItem('webAllowedOrigins') as HTMLTextAreaElement).value = (
        savedWebOrigins?.length ? savedWebOrigins : DEFAULT_WEB_ALLOWED_ORIGINS
      ).join('\n')
      ;(form.elements.namedItem('theme') as HTMLSelectElement).value = store.getState().theme
      ;(form.elements.namedItem('fontSize') as HTMLInputElement).value = String(
        store.getState().fontSize,
      )
      ;(form.elements.namedItem('autoPortraitRightPanel') as HTMLInputElement).checked =
        store.getState().autoPortraitRightPanel
      ;(form.elements.namedItem('rightPanelPosition') as HTMLSelectElement).value =
        store.getState().rightPanelPosition

      const savedIconVariant = await api.settings.get('appIconVariant')
      const appIconVariant = isAppIconVariant(savedIconVariant)
        ? savedIconVariant
        : DEFAULT_APP_ICON_VARIANT
      const iconRadio = form.querySelector<HTMLInputElement>(
        `input[name="appIconVariant"][value="${appIconVariant}"]`,
      )
      if (iconRadio) iconRadio.checked = true

      await refreshLocalModelSelects()
      await ghCliSection.refreshStatus()
      await refreshMcpServers()
      await refreshCuratedServers()
    })()
  })

  const settingsForm = overlay.querySelector('form')
  if (!settingsForm) throw new Error('Settings dialog template is missing "form"')
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async (): Promise<void> => {
      const data = new FormData(settingsForm)

      await cursorKeySection.saveKeys()
      await claudeAgentKeySection.saveKeys()
      await customProvidersSection.saveKeys()
      await localProvidersSection.saveKeys()
      await lmStudioSection.saveConnection()
      const routingValues = modelRoutingSection.readValues()

      const model = data.get('model') as string
      const theme = data.get('theme') as 'light' | 'dark'
      const fontSize = parseInt(data.get('fontSize') as string, 10)
      const autoPortraitRightPanel = data.get('autoPortraitRightPanel') === 'on'
      const rightPanelPositionRaw = data.get('rightPanelPosition')
      const rightPanelPosition = isRightPanelPosition(rightPanelPositionRaw)
        ? rightPanelPositionRaw
        : 'auto'
      const appIconVariant = data.get('appIconVariant') as AppIconVariant
      const confidence = parseFloat(data.get('safetyConfidenceThreshold') as string)

      await api.settings.set('model', model)
      await api.settings.set(
        'smallTasksModel',
        ((data.get('smallTasksModel') as string | null) ?? '').trim(),
      )
      await saveSimpleFields(data, api)
      await api.settings.set('theme', theme)
      await api.settings.set('fontSize', fontSize)
      await api.settings.set('autoPortraitRightPanel', autoPortraitRightPanel)
      await api.settings.set('rightPanelPosition', rightPanelPosition)
      if (isAppIconVariant(appIconVariant)) {
        await api.settings.set('appIconVariant', appIconVariant)
        await api.appIcon.apply()
      }
      await api.settings.set('localDefaultModel', routingValues.localDefaultModel)
      await api.settings.set('subagentModel', routingValues.subagentModel)
      await api.settings.setSecurity({
        localServerUrl: lmStudioSection.getUrl(),
        safetyModel: routingValues.safetyModel,
        reviewModel: routingValues.reviewModel,
        safetyClassifierEnabled: data.get('safetyClassifierEnabled') === 'on',
        safetyConfidenceThreshold: Number.isFinite(confidence) ? confidence : 0.85,
        autoRunSandboxCommands: data.get('autoRunSandboxCommands') === 'on',
        mcpAutoAllowReadOnly: data.get('mcpAutoAllowReadOnly') === 'on',
        defaultReadonlyMode: data.get('defaultReadonlyMode') === 'on',
        webAllowedOrigins: parseWebAllowedOrigins(data.get('webAllowedOrigins')),
        webAllowUserApproval: data.get(WEB_ALLOW_USER_APPROVAL_SETTING) === 'on',
      })

      store.setState({
        theme,
        fontSize,
        autoPortraitRightPanel,
        rightPanelPosition,
        settings: { ...store.getState().settings, model },
      })
      store.emit('theme_changed', theme)
      store.emit('settings_changed')
      window.dispatchEvent(new Event('copse:skills-changed'))
      document.documentElement.dataset['theme'] = theme
      closeSettingsDialog()
    })()
  })

  qsRequired(overlay, '#settings-cancel').addEventListener('click', closeSettingsDialog)
  qsRequired(overlay, '#settings-close').addEventListener('click', closeSettingsDialog)
}
