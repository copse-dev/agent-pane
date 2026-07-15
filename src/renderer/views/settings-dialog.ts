import { errorMessage } from '@shared/errors.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  isRightPanelPosition,
  isThemePreference,
  DEFAULT_THEME_PREFERENCE,
} from '@shared/types/state.ts'
import { resolveTheme } from '../dom/theme.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  APP_ICON_VARIANTS,
  APP_ICON_VARIANT_LABELS,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
  type AppIconVariant,
} from '@shared/app-icon-variants.ts'
import { DEFAULT_CLOUD_MODEL } from '@copse/llm/model-catalog.ts'
import { DEFAULT_ADVISOR_MODEL } from '../../main/services/advisor-strategy.ts'
import {
  DEFAULT_COMPARISON_MODEL_B,
  DEFAULT_COMPARISON_JUDGE_MODEL,
} from '../../main/services/model-comparison.ts'
import { qsRequired } from '../dom/helpers.ts'
import { inlineStatus, setInlineStatus } from '../dom/inline-status.ts'
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
import {
  TRUSTED_COMMANDS_SETTING,
  formatTrustedCommands,
  parseTrustedCommands,
  sanitizeTrustedCommands,
} from '@shared/command-routing.ts'

export type SettingsSection =
  | 'general'
  | 'usage'
  | 'local-models'
  | 'mcp'
  | 'sources'
  | 'appearance'
  | 'experimental'

/**
 * Whole-app tint (Appearance ▸ Interface tint). The hue is mixed into every
 * neutral surface at a strength that maps to a percentage; `off` disables it.
 * Applied by writing --tint-hue / --tint-amount on the document root, which
 * tokens.css folds into every --bg-* surface (see its --tint-* comment).
 */
export type UiTintStrength = 'off' | 'subtle' | 'medium' | 'strong'
// Ships on by default as a gentle wash that matches the default "Rose" app
// icon (its #F472B6 mark). Users can dial it up, recolour it, or set the
// strength to Off for the plain neutral surfaces.
export const DEFAULT_TINT_COLOR = '#F472B6'
export const DEFAULT_TINT_STRENGTH: UiTintStrength = 'subtle'
const TINT_STRENGTH_AMOUNTS: Record<UiTintStrength, string> = {
  off: '0%',
  subtle: '4%',
  medium: '7%',
  strong: '10%',
}
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function isUiTintStrength(value: unknown): value is UiTintStrength {
  return value === 'off' || value === 'subtle' || value === 'medium' || value === 'strong'
}

/** Push the tint onto the document root so every surface picks it up at once. */
export function applyUiTint(color: string, strength: UiTintStrength): void {
  const root = document.documentElement
  if (HEX_COLOR.test(color)) root.style.setProperty('--tint-hue', color)
  root.style.setProperty('--tint-amount', TINT_STRENGTH_AMOUNTS[strength])
}

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
  kind: 'checkbox' | 'text' | 'number'
  default: boolean | string | number
  /** Whether the save handler writes this field via api.settings.set. */
  save: boolean
}

const SIMPLE_FIELDS: readonly SettingField[] = [
  { name: 'customInstructions', kind: 'text', default: '', save: true },
  { name: 'externalApiSafety', kind: 'checkbox', default: false, save: true },
  { name: 'remoteAgentAutoCreatePR', kind: 'checkbox', default: true, save: true },
  { name: 'remoteAgentWorkOnCurrentBranch', kind: 'checkbox', default: false, save: true },
  { name: 'localSubagentsEnabled', kind: 'checkbox', default: true, save: true },
  {
    name: 'subagentsEnabled',
    kind: 'checkbox',
    default: false,
    save: true,
  },
  { name: 'localTodoItemsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'postTurnReviewEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'postTurnReviewMinChangedLines', kind: 'number', default: 1, save: true },
  { name: 'bundledCursorSkillsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'skillExternalLinkWarnings', kind: 'checkbox', default: true, save: true },
  { name: 'skillSandboxGuidance', kind: 'checkbox', default: true, save: true },
  // Built-in browser tools (Electron's bundled Chromium); on by default so the
  // agent renders/screenshots web UIs in-app instead of installing a browser.
  { name: 'browserToolsEnabled', kind: 'checkbox', default: true, save: true },
  // On by default: clicked links open in the in-app browser pane. Off routes
  // external links to the system browser and marks them with an external icon.
  { name: 'openLinksInBuiltInBrowser', kind: 'checkbox', default: true, save: true },
  { name: 'acpAutoApproveEditsWithBackup', kind: 'checkbox', default: true, save: true },
  { name: 'acpAutoApproveNativeBridgeTools', kind: 'checkbox', default: true, save: true },
  // Experimental, opt-in features (off by default).
  { name: 'mcpUiArtefactsEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'ciInvestigatorEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'okfMemoriesEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'longHorizonTasksEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'modelClassifierEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'advisorStrategyEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'modelComparisonEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'modelComparisonAutoOnReview', kind: 'checkbox', default: false, save: true },
  { name: 'roadmapPlansEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'backgroundTasksEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'piiRedactionEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'devtoolsShortcutEnabled', kind: 'checkbox', default: false, save: true },
  // Loaded here; saved as part of the setSecurity() bundle below.
  { name: 'safetyClassifierEnabled', kind: 'checkbox', default: true, save: false },
  { name: 'autoRunSandboxCommands', kind: 'checkbox', default: true, save: false },
  { name: 'mcpAutoAllowReadOnly', kind: 'checkbox', default: false, save: false },
  { name: 'defaultReadonlyMode', kind: 'checkbox', default: false, save: false },
  { name: 'webAllowUserApproval', kind: 'checkbox', default: true, save: false },
  { name: 'safetyExternalDenyThreshold', kind: 'text', default: '1', save: false },
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

/** Parse a `number`-kind field's form value, clamping to a non-negative integer. */
function parseNonNegativeInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Keep the strict-deny slider's numeric readout in sync as it moves. Called after
 * the generic field load.
 */
function wireSafetySliders(form: HTMLFormElement): void {
  const externalDeny = form.elements.namedItem('safetyExternalDenyThreshold') as HTMLInputElement

  const bind = (input: HTMLInputElement): void => {
    const output = form.querySelector<HTMLOutputElement>(`output[for="${input.name}"]`)
    if (!output) return
    const sync = (): void => {
      output.textContent = Number(input.value).toFixed(2)
    }
    input.addEventListener('input', sync)
    sync()
  }
  bind(externalDeny)
}

async function saveSimpleFields(data: FormData, api: ApiClient): Promise<void> {
  for (const field of SIMPLE_FIELDS) {
    if (!field.save) continue
    if (field.kind === 'checkbox') {
      await api.settings.set(field.name, data.get(field.name) === 'on')
    } else if (field.kind === 'number') {
      const value = (data.get(field.name) as string | null) ?? ''
      await api.settings.set(field.name, parseNonNegativeInt(value, field.default as number))
    } else {
      const value = (data.get(field.name) as string | null) ?? ''
      const trimmed = field.name === 'customInstructions'
      await api.settings.set(field.name, trimmed ? value.trim() : value)
    }
  }
}

/** Read a text field from FormData, narrowing to string without a cast. */
function formDataString(data: FormData, key: string): string {
  const value = data.get(key)
  return typeof value === 'string' ? value : ''
}

function parseWebAllowedOrigins(value: FormDataEntryValue | null): string[] {
  const text = typeof value === 'string' ? value : ''
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

let overlayEl: HTMLDialogElement | null = null
// Section to reveal on the next open (e.g. a deep-link from the low-context
// warning). Read and cleared by the `settings-open` handler; null → General.
let pendingSection: SettingsSection | null = null

export function openSettingsDialog(section?: SettingsSection): void {
  if (!overlayEl || overlayEl.open) return
  pendingSection = section ?? null
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
          <div class="settings-search">
            <input
              type="search"
              id="settings-search-input"
              class="settings-search-input"
              placeholder="Search settings…"
              aria-label="Search all settings"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <button type="button" class="settings-nav-btn active" data-section="general">General</button>
          <button type="button" class="settings-nav-btn" data-section="usage">Usage</button>
          <button type="button" class="settings-nav-btn" data-section="local-models">Local models</button>
          <button type="button" class="settings-nav-btn" data-section="mcp">MCP servers</button>
          <button type="button" class="settings-nav-btn" data-section="sources">Sources</button>
          <button type="button" class="settings-nav-btn" data-section="appearance">Appearance</button>
          <button type="button" class="settings-nav-btn" data-section="experimental">Experimental</button>
        </nav>

        <form class="settings-content">
          <section class="settings-section active" data-section="general">
            <h3>General</h3>
            <p class="settings-section-desc">
              Cloud API keys, default chat model, and task-specific model choices.
            </p>

            <!-- JS-mounted panels sit in a host <div>. Any such host that holds a
                 top-level panel MUST carry class="settings-mount" so its injected
                 fieldset gets the same inter-panel spacing as inline ones — see the
                 .settings-section > .settings-mount > fieldset rule in settings.css. -->
            <div id="settings-custom-providers-host" class="settings-mount"></div>

            <div id="settings-env-detect-host" class="settings-mount"></div>

            <fieldset>
              <legend>Chat model</legend>
              <label>
                Default model
                <select name="model"></select>
              </label>
              <span class="field-hint">
                Pick a cloud, local, or remote-agent model here (or from the model picker beside the
                chat box). Selecting <strong>Cursor Cloud Agent</strong> sends each turn to Cursor
                Cloud instead of running it on this machine — configure it in the Remote agents
                section.
              </span>
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
                These apply to whichever remote agent you run. The agent works on this project's
                <code>origin</code> repository, branching from your current branch.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="remoteAgentAutoCreatePR" />
                Open a pull request automatically when the remote agent finishes
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="remoteAgentWorkOnCurrentBranch" />
                Push directly to the current branch instead of a new branch
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

            <div id="settings-model-routing-host" class="settings-mount"></div>

            <div id="settings-gh-cli-host" class="settings-mount"></div>

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
                  Appended to the system prompt for every thread. A project
                  <code>AGENT.md</code>, <code>AGENTS.md</code>, or <code>CLAUDE.md</code> adds
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
                <input type="checkbox" name="openLinksInBuiltInBrowser" />
                Open links in the built-in browser
              </label>
              <p class="field-hint">
                When on, http(s) links you click in chat, PR, and preview surfaces open in the
                in-app browser pane. Turn off to open them in your default browser instead — external
                links then show an
                <span class="external-link-hint-icon" aria-hidden="true"></span> icon.
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
            <div id="settings-usage-host" class="settings-mount"></div>
          </section>

          <section class="settings-section" data-section="local-models">
            <h3>Local models</h3>
            <p class="settings-section-desc">
              Connect to an LM Studio (or other OpenAI-compatible) server.
            </p>

            <div id="settings-local-providers-host" class="settings-mount"></div>

            <fieldset>
              <legend>Routing behavior</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="subagentsEnabled" />
                Route reads and searches through exploration subagents
              </label>
              <p class="field-hint">
                When on, the parent model uses <code>explore</code> instead of direct
                <code>read_file</code> / search tools (summarized exploration). When off — the
                default — the parent gets direct read/search tools, similar to ACP coding agents
                (Read/Grep-style) and is less likely to fall back to <code>run_shell</code>.
              </p>
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
              <label>
                Skip that review below this many changed lines (1 = only skip an empty
                diff, 0 = always review)
                <input
                  type="number"
                  name="postTurnReviewMinChangedLines"
                  min="0"
                  step="1"
                  class="settings-number-input"
                />
              </label>
              <p class="field-hint">
                When the review runs on a paid model, you'll be asked to approve the spend
                once per chat. Set a local review model above to review for free.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="safetyClassifierEnabled" />
                Use instruct model to identify dangerous external shell commands for strict-mode blocking
              </label>
              <label>
                Strict-mode external deny confidence
                <span class="slider-row">
                  <input
                    type="range"
                    name="safetyExternalDenyThreshold"
                    min="0"
                    max="1"
                    step="0.05"
                  />
                  <output class="slider-value" for="safetyExternalDenyThreshold">1.00</output>
                </span>
                <span class="field-hint">Hard-block (no prompt) commands the model is at least this confident are dangerous and external. Leave at 1.00 to disable.</span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="autoRunSandboxCommands" />
                Auto-run shell commands contained within the sandbox
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="acpAutoApproveEditsWithBackup" />
                Auto-approve external agent file edits (a backup is taken first)
              </label>
              <p class="field-hint">
                External ACP agents (e.g. Claude) skip the per-edit approval modal for
                edits, deletes, and moves once Copse has snapshotted your uncommitted work to a
                restorable <code>refs/copse/backups/*</code> ref. If an edit overwrites your
                uncommitted work, the Changes panel offers a one-click
                <strong>Restore pre-session changes</strong> to bring it back. Shell commands and web
                fetches still prompt. Turn off to review every agent file edit.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="acpAutoApproveNativeBridgeTools" />
                Auto-approve calls to Copse's own bridged tools
              </label>
              <p class="field-hint">
                External ACP agents reach Copse's own tools (GitHub/CI, semantic search, staged
                diffs, browser, web fetch) through a bridge that re-applies Copse's native
                permission checks when each call runs — so the extra approval prompt only duplicates
                that gate. Turn off to prompt for every bridged tool call.
              </p>
            </fieldset>

            <fieldset>
              <legend>Trusted commands</legend>
              <p class="settings-fieldset-desc">
                Commands trusted to run <strong>unsandboxed with no prompt</strong> — for tools that
                can't run inside the workspace sandbox but are safe (e.g.
                <code>xcodebuild</code>). A line like <code>mkdir build &amp;&amp; xcodebuild …</code>
                runs without a prompt because <code>mkdir</code> is a trivially-safe prep step and
                <code>xcodebuild</code> is trusted; a destructive, network, or untrusted segment
                (e.g. <code>curl</code>, <code>npm test</code>) makes the whole line prompt as usual.
                Only honoured in a trusted workspace and when auto-run is on; shells and interpreters
                (<code>sh</code>, <code>bash</code>, <code>node</code>, …) can't be trusted this way.
              </p>
              <label>
                Trusted command names
                <textarea
                  name="trustedShellCommands"
                  rows="5"
                  spellcheck="false"
                  placeholder="xcodebuild"
                ></textarea>
                <span class="field-hint">
                  One command basename per line (e.g. <code>xcodebuild</code>). Matches the command's
                  basename only, never its arguments.
                </span>
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

          <section class="settings-section" data-section="sources">
            <h3>Sources</h3>
            <p class="settings-section-desc">
              Everything Copse auto-loads for this workspace. Read-only — edit the underlying
              files to change what's loaded.
            </p>
            <div class="lmstudio-test-row">
              <button type="button" id="sources-reload-btn">Reload</button>
              <span class="lmstudio-test-status" id="sources-reload-status"></span>
            </div>

            <fieldset>
              <legend>Instruction files</legend>
              <p class="settings-fieldset-desc">
                Files appended to the system prompt, in precedence order. Global steering
                (<code>~/AGENTS.md</code>, <code>~/.claude/CLAUDE.md</code>) loads first, then
                project <code>AGENT.md</code>/<code>AGENTS.md</code> (cross-tool),
                <code>CLAUDE.md</code> (Claude Code), and Cursor rules
                (<code>.cursor/rules/*.mdc</code> marked <code>alwaysApply</code>, plus
                <code>.cursorrules</code>) when present.
              </p>
              <div id="sources-instructions-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset>
              <legend>Skills</legend>
              <p class="settings-fieldset-desc">
                Skills discovered on disk, tagged by where they came from. Manage inclusion of
                bundled Cursor skills under General → Skills.
              </p>
              <div id="sources-skills-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset>
              <legend>Hooks</legend>
              <p class="settings-fieldset-desc">
                Cursor hooks from <code>~/.cursor/hooks.json</code> and Claude Code hooks from
                <code>~/.claude/settings.json</code> (user). When the workspace is trusted, also
                <code>.cursor/hooks.json</code> and <code>.claude/settings.json</code> (project).
                Permission hooks can block or gate the agent's tool calls.
              </p>
              <div id="sources-hooks-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset>
              <legend>Plugins</legend>
              <p class="settings-fieldset-desc">
                Cursor plugins installed under <code>~/.cursor/plugins/</code>. Each can contribute
                skills and MCP servers.
              </p>
              <div id="sources-plugins-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
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
                  <option value="system">System</option>
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
              <legend>Interface tint</legend>
              <p class="settings-fieldset-desc">
                Wash a colour through every surface — panels, sidebars, hovers, and the chat
                background. Kept subtle by design; leave the strength at Off for the plain neutral
                theme. Works in both light and dark.
              </p>
              <label>
                Tint colour
                <input type="color" name="uiTintColor" />
              </label>
              <label>
                Strength
                <select name="uiTintStrength">
                  <option value="off">Off</option>
                  <option value="subtle">Subtle</option>
                  <option value="medium">Medium</option>
                  <option value="strong">Strong</option>
                </select>
              </label>
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
                    <img src="./icon-previews/${variant}.png" alt="" width="80" height="80" />
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

            <div id="settings-acp-agents-host" class="settings-mount"></div>

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
              <legend>Model comparison</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="modelComparisonEnabled" />
                Compare two models on the working diff
              </label>
              <p class="field-hint">
                Adds a <code>compare_models</code> tool that reviews the current diff through two
                models independently, then a judge model compares their verdicts (agreements,
                disagreements, and what each caught that the other missed). Since a run makes up to
                three model calls, it asks for approval before spending on any paid model (you can
                choose to remember the choice for the session). While off, the tool is not registered.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="modelComparisonAutoOnReview" />
                Run the comparison automatically after editing turns
              </label>
              <p class="field-hint">
                When on, the comparison runs as part of the post-turn review (still gated by the
                spend approval). When off, run it on demand via the <code>compare_models</code> tool.
              </p>
              <label class="field-label" for="comparisonModelA">Reviewer A</label>
              <select id="comparisonModelA" name="comparisonModelA">
                <option value="">(loading…)</option>
              </select>
              <p class="field-hint">First reviewer. Leave blank to use your current chat model.</p>
              <label class="field-label" for="comparisonModelB">Reviewer B</label>
              <select id="comparisonModelB" name="comparisonModelB">
                <option value="">(loading…)</option>
              </select>
              <p class="field-hint">
                Second reviewer — pick a different model than Reviewer A. Defaults to
                <code>claude-opus-4-8</code>.
              </p>
              <label class="field-label" for="comparisonJudgeModel">Judge</label>
              <select id="comparisonJudgeModel" name="comparisonJudgeModel">
                <option value="">(loading…)</option>
              </select>
              <p class="field-hint">
                Model that compares the two reviews. Defaults to <code>claude-opus-4-8</code>.
              </p>
            </fieldset>

            <fieldset>
              <legend>Roadmap plans</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="roadmapPlansEnabled" />
                Let the agent keep a roadmap of future-work prompts
              </label>
              <p class="field-hint">
                Adds a <code>roadmap_plan</code> tool and a Roadmap pane (titlebar button) for
                jotting prompts to run over a longer time horizon than the current change, with a
                per-item status (ready / blocked / conflicts / done) tracked across sessions — a
                notes app for future work, so longer-horizon plans aren't started before the PRs
                they depend on merge. Items are stored per project in the knowledge store under
                <code>~/.copse/knowledge</code>. While off, the tool is not registered and the
                pane is hidden.
              </p>
            </fieldset>

            <fieldset>
              <legend>Background tasks</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="backgroundTasksEnabled" />
                Let the agent run long-lived background commands (dev servers, watchers)
              </label>
              <p class="field-hint">
                Adds a <code>run_background</code> tool that starts a long-running command
                (<code>npm run dev</code>, a build/test watcher, …) and keeps it alive across turns,
                with list / logs / stop actions. A task can opt into binding a local port — for a
                dev server — which reports its <code>http://localhost:&lt;port&gt;</code> URL so the
                agent can open it in the built-in browser; that asks for your permission the first
                time per project and relaxes the sandbox only to allow binding on localhost.
                Otherwise a task stays fully sandboxed (workspace-only, no network). Tasks are
                stopped when the app quits. While off, the tool is not registered.
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

            <fieldset>
              <legend>DevTools shortcut</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="devtoolsShortcutEnabled" />
                Enable <code>Ctrl+Shift+I</code> to toggle Developer Tools
              </label>
              <p class="field-hint">
                Registers a keyboard shortcut to open the Electron DevTools window. Useful for
                debugging the app itself (not the agent conversation). While off, no shortcut is
                registered and the DevTools window cannot be opened.
              </p>
            </fieldset>
          </section>

          <div class="settings-search-results" id="settings-search-results"></div>

          <p class="settings-search-empty" id="settings-search-empty" hidden></p>

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
  const contentEl = qsRequired(overlay, '.settings-content')
  const searchInput = qsRequired<HTMLInputElement>(overlay, '#settings-search-input')
  const searchEmpty = qsRequired(overlay, '#settings-search-empty')
  const searchResults = qsRequired(overlay, '#settings-search-results')
  // The section a nav button last selected, restored when a search is cleared.
  let activeSection: SettingsSection = 'general'
  // Blocks lifted into the results list, each with the comment node marking the
  // spot to drop it back into when the search is cleared.
  let liftedBlocks: { node: HTMLElement; marker: Comment }[] = []
  // Async section content (ACP agents, Sources lists) loads only when its tab is
  // opened; search reveals those blocks too, so populate them once per open.
  let searchContentLoaded = false

  function showSection(id: SettingsSection): void {
    activeSection = id
    navBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset['section'] === id))
    sections.forEach((sec) => sec.classList.toggle('active', sec.dataset['section'] === id))
  }

  // A settings "block" is a top-level fieldset — one not nested inside another
  // (LM Studio sits inside Local providers, so it isn't its own block).
  function topLevelBlocks(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('fieldset')).filter(
      (fs) => !fs.parentElement?.closest('fieldset'),
    )
  }

  // Return each lifted block to the marker left in its original position.
  function restoreLiftedBlocks(): void {
    for (const { node, marker } of liftedBlocks) marker.replaceWith(node)
    liftedBlocks = []
  }

  /**
   * Cross-section search: type text and every settings block (a top-level
   * `<fieldset>`) whose text contains it is collected into one results list, no
   * matter which section it lives in. Blocks are shown whole — never cropped —
   * and ranked so a hit in the block's own heading (its legend) sorts above one
   * that only matched body text, since the heading names what the block is. With
   * the box empty, the normal one-section-at-a-time view is restored.
   */
  function applySearch(raw: string): void {
    // Always start from a clean slate so each keystroke re-ranks from scratch.
    restoreLiftedBlocks()
    const query = raw.trim().toLowerCase()
    if (!query) {
      contentEl.classList.remove('settings-searching')
      searchEmpty.hidden = true
      searchResults.replaceChildren()
      showSection(activeSection)
      return
    }

    // Pull in the lazily-loaded section content so matched blocks (e.g. the ACP
    // agents list) render fully rather than as an empty shell.
    if (!searchContentLoaded) {
      searchContentLoaded = true
      void acpAgentsSection.refresh()
      void refreshSources()
    }

    contentEl.classList.add('settings-searching')
    const matches: { node: HTMLElement; rank: number }[] = []
    sections.forEach((sec) => {
      for (const block of topLevelBlocks(sec)) {
        if (!block.textContent.toLowerCase().includes(query)) continue
        const legend = block.querySelector('legend')?.textContent.toLowerCase() ?? ''
        matches.push({ node: block, rank: legend.includes(query) ? 0 : 1 })
      }
    })
    // Stable sort (legend matches first) keeps document order within each rank.
    matches.sort((a, b) => a.rank - b.rank)
    for (const { node } of matches) {
      const marker = document.createComment('lifted settings block')
      node.replaceWith(marker)
      searchResults.append(node)
      liftedBlocks.push({ node, marker })
    }
    if (matches.length === 0) {
      searchEmpty.textContent = `No settings match “${raw.trim()}”.`
      searchEmpty.hidden = false
    } else {
      searchEmpty.hidden = true
    }
  }

  searchInput.addEventListener('input', () => {
    applySearch(searchInput.value)
  })

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset['section'] as SettingsSection | undefined
      if (id) {
        // Selecting a section is an explicit exit from search results.
        if (searchInput.value) {
          searchInput.value = ''
          applySearch('')
        }
        showSection(id)
        if (id === 'usage') void usageSection.refresh()
        // Defer disk scans until each tab is opened, so users who never visit them
        // don't trigger a which/ps scan (Experimental) or fs walk (Sources) on open.
        if (id === 'experimental') void acpAgentsSection.refresh()
        if (id === 'sources') void refreshSources()
      }
    })
  })

  async function refreshLocalModelSelects(): Promise<void> {
    await modelRoutingSection.refresh()
  }

  function makeSourceRow(
    title: string,
    badge: string | null,
    detail: string | null,
    opts: { badgeClass?: string | undefined } = {},
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'sources-row'
    const header = document.createElement('div')
    header.className = 'sources-row-header'
    const titleEl = document.createElement('span')
    titleEl.className = 'sources-row-title'
    titleEl.textContent = title
    header.append(titleEl)
    if (badge) {
      const badgeEl = document.createElement('span')
      badgeEl.className = opts.badgeClass ? `sources-badge ${opts.badgeClass}` : 'sources-badge'
      badgeEl.textContent = badge
      header.append(badgeEl)
    }
    row.append(header)
    if (detail) {
      const detailEl = document.createElement('div')
      detailEl.className = 'sources-row-detail'
      detailEl.textContent = detail
      row.append(detailEl)
    }
    return row
  }

  function fillSourceList(selector: string, rows: HTMLElement[], emptyText: string): void {
    const el = qsRequired(overlay, selector)
    el.innerHTML = ''
    if (rows.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'sources-empty'
      empty.textContent = emptyText
      el.append(empty)
      return
    }
    for (const row of rows) el.append(row)
  }

  async function refreshSources(): Promise<void> {
    const statusEl = qsRequired(overlay, '#sources-reload-status')
    statusEl.textContent = 'Loading…'
    try {
      const [instructions, skills, hooks, plugins] = await Promise.all([
        api.instructions.list(),
        api.skills.list(),
        api.hooks.list(),
        api.plugins.list(),
      ])

      fillSourceList(
        '#sources-instructions-list',
        instructions.map((f) =>
          makeSourceRow(f.name, f.scope, `${f.path} · ${String(f.bytes)} B`, {
            badgeClass: f.scope === 'project' ? 'sources-badge-project' : undefined,
          }),
        ),
        'No instruction files (add AGENT.md, AGENTS.md, or CLAUDE.md to the workspace root, or ~/AGENTS.md globally).',
      )

      fillSourceList(
        '#sources-skills-list',
        skills.map((s) =>
          makeSourceRow(s.name, s.source, s.description || s.skillPath, {
            badgeClass: s.source === 'project' ? 'sources-badge-project' : undefined,
          }),
        ),
        'No skills discovered.',
      )

      fillSourceList(
        '#sources-hooks-list',
        hooks.map((h) => {
          const title = h.family === 'claude' && h.matcher ? `${h.event} · ${h.matcher}` : h.event
          const detail = `${h.family === 'claude' ? 'Claude Code' : 'Cursor'} · ${h.command}`
          return makeSourceRow(title, h.scope, detail, {
            badgeClass: h.scope === 'project' ? 'sources-badge-project' : undefined,
          })
        }),
        'No Cursor or Claude Code hooks configured.',
      )

      fillSourceList(
        '#sources-plugins-list',
        plugins.map((p) => {
          const caps: string[] = []
          if (p.skillsDir) caps.push('skills')
          if (p.mcpConfigPath) caps.push('MCP')
          const detail = [caps.length ? caps.join(' + ') : 'no capabilities', p.root]
            .filter(Boolean)
            .join(' · ')
          return makeSourceRow(p.version ? `${p.name} (${p.version})` : p.name, null, detail)
        }),
        'No Cursor plugins installed.',
      )

      statusEl.textContent = ''
    } catch {
      statusEl.textContent = 'Failed to load sources.'
    }
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
      const badge: Node =
        s.state === 'connected'
          ? inlineStatus('filled', 'connected')
          : s.state === 'error'
            ? inlineStatus('error', 'error')
            : s.state === 'disabled'
              ? inlineStatus('pending', 'disabled')
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
      title.append(`${s.name} (${s.transport}) — `, badge)

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
        if (s.state === 'connected') {
          setInlineStatus(
            status,
            'filled',
            `connected — ${String(s.toolCount)} tool(s)${s.tools.length ? `: ${s.tools.join(', ')}` : ''}`,
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
        setInlineStatus(
          statusEl,
          'ok',
          `${String(ok)}/${String(visible.length)} server(s) connected`,
        )
        statusEl.classList.add('ok')
      })
      .catch((err: unknown) => {
        setInlineStatus(statusEl, 'error', errorMessage(err))
        statusEl.classList.add('err')
      })
  })

  qsRequired(overlay, '#sources-reload-btn').addEventListener('click', () => {
    void refreshSources()
  })

  overlay.addEventListener('settings-open', () => {
    // A fresh open always starts on a section, never in a leftover search.
    searchContentLoaded = false
    if (searchInput.value) {
      searchInput.value = ''
    }
    applySearch('')
    showSection(pendingSection ?? 'general')
    pendingSection = null
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
      const comparisonModelA = (await api.settings.get('comparisonModelA')) as string | undefined
      await populateModelSelect(
        form.elements.namedItem('comparisonModelA') as HTMLSelectElement,
        api,
        comparisonModelA ?? '',
      )
      const comparisonModelB = (await api.settings.get('comparisonModelB')) as string | undefined
      await populateModelSelect(
        form.elements.namedItem('comparisonModelB') as HTMLSelectElement,
        api,
        comparisonModelB ?? DEFAULT_COMPARISON_MODEL_B,
      )
      const comparisonJudgeModel = (await api.settings.get('comparisonJudgeModel')) as
        | string
        | undefined
      await populateModelSelect(
        form.elements.namedItem('comparisonJudgeModel') as HTMLSelectElement,
        api,
        comparisonJudgeModel ?? DEFAULT_COMPARISON_JUDGE_MODEL,
      )
      await loadSimpleFields(form, api)
      wireSafetySliders(form)
      const savedWebOrigins = (await api.settings.get(WEB_ALLOWED_ORIGINS_SETTING)) as
        | string[]
        | undefined
        | null
      ;(form.elements.namedItem('webAllowedOrigins') as HTMLTextAreaElement).value = (
        savedWebOrigins?.length ? savedWebOrigins : DEFAULT_WEB_ALLOWED_ORIGINS
      ).join('\n')
      ;(form.elements.namedItem('trustedShellCommands') as HTMLTextAreaElement).value =
        formatTrustedCommands(
          sanitizeTrustedCommands(await api.settings.get(TRUSTED_COMMANDS_SETTING)),
        )
      ;(form.elements.namedItem('theme') as HTMLSelectElement).value =
        store.getState().themePreference
      ;(form.elements.namedItem('fontSize') as HTMLInputElement).value = String(
        store.getState().fontSize,
      )
      ;(form.elements.namedItem('autoPortraitRightPanel') as HTMLInputElement).checked =
        store.getState().autoPortraitRightPanel
      ;(form.elements.namedItem('rightPanelPosition') as HTMLSelectElement).value =
        store.getState().rightPanelPosition

      const savedTintColor = await api.settings.get('uiTintColor')
      ;(form.elements.namedItem('uiTintColor') as HTMLInputElement).value =
        typeof savedTintColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(savedTintColor)
          ? savedTintColor
          : DEFAULT_TINT_COLOR
      const savedTintStrength = await api.settings.get('uiTintStrength')
      ;(form.elements.namedItem('uiTintStrength') as HTMLSelectElement).value = isUiTintStrength(
        savedTintStrength,
      )
        ? savedTintStrength
        : DEFAULT_TINT_STRENGTH

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
      const themePrefRaw = data.get('theme')
      const themePreference = isThemePreference(themePrefRaw)
        ? themePrefRaw
        : DEFAULT_THEME_PREFERENCE
      // `theme` is the concrete value panes render; `system` resolves against the OS.
      const theme = resolveTheme(themePreference)
      const fontSize = parseInt(data.get('fontSize') as string, 10)
      const autoPortraitRightPanel = data.get('autoPortraitRightPanel') === 'on'
      const rightPanelPositionRaw = data.get('rightPanelPosition')
      const rightPanelPosition = isRightPanelPosition(rightPanelPositionRaw)
        ? rightPanelPositionRaw
        : 'auto'
      const appIconVariant = data.get('appIconVariant') as AppIconVariant
      const externalDeny = parseFloat(data.get('safetyExternalDenyThreshold') as string)

      const tintColorRaw = data.get('uiTintColor')
      const uiTintColor =
        typeof tintColorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(tintColorRaw)
          ? tintColorRaw
          : DEFAULT_TINT_COLOR
      const tintStrengthRaw = data.get('uiTintStrength')
      const uiTintStrength = isUiTintStrength(tintStrengthRaw)
        ? tintStrengthRaw
        : DEFAULT_TINT_STRENGTH

      await api.settings.set('model', model)
      await api.settings.set(
        'smallTasksModel',
        ((data.get('smallTasksModel') as string | null) ?? '').trim(),
      )
      for (const key of ['comparisonModelA', 'comparisonModelB', 'comparisonJudgeModel'] as const) {
        await api.settings.set(key, ((data.get(key) as string | null) ?? '').trim())
      }
      await saveSimpleFields(data, api)
      await api.settings.set('theme', themePreference)
      await api.settings.set('fontSize', fontSize)
      await api.settings.set('autoPortraitRightPanel', autoPortraitRightPanel)
      await api.settings.set('rightPanelPosition', rightPanelPosition)
      await api.settings.set('uiTintColor', uiTintColor)
      await api.settings.set('uiTintStrength', uiTintStrength)
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
        safetyExternalDenyThreshold: Number.isFinite(externalDeny) ? externalDeny : 1,
        autoRunSandboxCommands: data.get('autoRunSandboxCommands') === 'on',
        mcpAutoAllowReadOnly: data.get('mcpAutoAllowReadOnly') === 'on',
        defaultReadonlyMode: data.get('defaultReadonlyMode') === 'on',
        webAllowedOrigins: parseWebAllowedOrigins(data.get('webAllowedOrigins')),
        webAllowUserApproval: data.get(WEB_ALLOW_USER_APPROVAL_SETTING) === 'on',
        trustedShellCommands: parseTrustedCommands(formDataString(data, 'trustedShellCommands')),
      })

      store.setState({
        theme,
        themePreference,
        fontSize,
        autoPortraitRightPanel,
        rightPanelPosition,
        openLinksInBuiltInBrowser: data.get('openLinksInBuiltInBrowser') === 'on',
        settings: { ...store.getState().settings, model },
      })
      store.emit('theme_changed', theme)
      store.emit('settings_changed')
      window.dispatchEvent(new Event('copse:skills-changed'))
      document.documentElement.dataset['theme'] = theme
      applyUiTint(uiTintColor, uiTintStrength)
      closeSettingsDialog()
    })()
  })

  qsRequired(overlay, '#settings-cancel').addEventListener('click', closeSettingsDialog)
  qsRequired(overlay, '#settings-close').addEventListener('click', closeSettingsDialog)
}
