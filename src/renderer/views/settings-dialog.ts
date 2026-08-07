import { errorMessage } from '@shared/errors.ts'
import {
  AUTO_APPROVAL_LEVEL_LABELS,
  AUTO_APPROVAL_LEVEL_SETTING,
  AUTO_APPROVAL_LEVELS,
  sanitizeAutoApprovalLevel,
} from '@shared/auto-approval.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  isRightPanelPosition,
  isThemePreference,
  DEFAULT_THEME_PREFERENCE,
} from '@shared/types/state.ts'
import { resolveTheme } from '../dom/theme.ts'
import { applyUiScale } from '../dom/ui-scale.ts'
import { clampUiScale, normalizeUiScale } from '@shared/ui-scale.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  APP_ICON_VARIANTS,
  APP_ICON_VARIANT_LABELS,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
} from '@shared/app-icon-variants.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { CURSOR_AGENTS_WEB_URL } from '@shared/remote-agent.ts'
import { validateAdvisorPair } from '../../main/services/advisor-strategy.ts'
import { DEFAULT_ORCHESTRATION_WORKER_MODEL } from '../../main/services/orchestration-strategy.ts'
import {
  ADVISOR_STRATEGY_PLUGIN_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/plugins/advisor-strategy-plugin.ts'
import { chevronDownIcon } from '../dom/icons.ts'
import type { WorktreeInventoryEntry } from '@shared/types/worktree.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { qsRequired } from '../dom/helpers.ts'
import { inlineStatus, setInlineStatus } from '../dom/inline-status.ts'
import {
  fetchDynamicModelOptions,
  fetchModelOptions,
  fetchSmallTasksModelOptions,
  modelDisplayLabel,
} from './model-options.ts'
import { mountModelSelectPicker } from './model-picker.ts'
import { createApiKeysSection } from './setup/api-keys-section.ts'
import { createProvidersPanel } from './setup/providers-section.ts'
import { createEnvKeyDetectSection } from './setup/env-key-detect-section.ts'
import { createLmStudioSection } from './setup/lm-studio-section.ts'
import { createGhCliSection } from './setup/gh-cli-section.ts'
import { createModelRoutingSection } from './setup/model-routing-section.ts'
import { createModelParametersSection } from './setup/model-parameters-section.ts'
import { createUsageSection } from './setup/usage-section.ts'
import { createSshWorkspaceSection } from './setup/ssh-workspace-section.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { createAutomationPluginSettings } from './automation-plugin-settings.ts'
import { PARALLEL_SEARCH_PLUGIN_ID } from '@copse/agent/plugins/parallel-search-plugin.ts'
import { createParallelSearchPluginSettings } from './parallel-search-plugin-settings.ts'
import {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  WEB_ALLOWED_ORIGINS_SETTING,
  WEB_ALLOW_USER_APPROVAL_SETTING,
} from '@shared/web-origins.ts'
import {
  APPROVED_PROVIDER_HOSTS_SETTING,
  PROVIDER_ALLOW_USER_APPROVAL_SETTING,
} from '@shared/provider-hosts.ts'
import {
  TRUSTED_COMMANDS_SETTING,
  formatTrustedCommands,
  parseTrustedCommands,
  sanitizeTrustedCommands,
} from '@shared/command-routing.ts'
import { stringRecordOrEmpty } from '@shared/unknown-value.ts'
import { DEVELOPER_MODE_SETTING } from '@shared/developer-mode.ts'

export type SettingsSection =
  | 'general'
  | 'usage'
  | 'agent'
  | 'permissions'
  | 'mcp'
  | 'customise'
  | 'storage'
  | 'appearance'
  | 'ssh'
  | 'experimental'

function isSettingsSection(value: unknown): value is SettingsSection {
  return (
    value === 'general' ||
    value === 'usage' ||
    value === 'agent' ||
    value === 'permissions' ||
    value === 'mcp' ||
    value === 'customise' ||
    value === 'storage' ||
    value === 'appearance' ||
    value === 'ssh' ||
    value === 'experimental'
  )
}

/**
 * Segments of a plugin id that are acronyms, and must stay uppercase rather than
 * being sentence-cased. Without this `copse.pii-redaction` reads "Pii
 * redaction" — a machine transformation showing through as user-facing copy.
 */
const PLUGIN_NAME_ACRONYMS = new Set(['acp', 'api', 'ci', 'llm', 'mcp', 'okf', 'pii', 'ui'])

/**
 * Friendly display name for a plugin row. First-party plugins ship with a
 * `copse.<kebab>` id; rather than showing that machine id verbatim, strip the
 * `copse.` prefix and present the rest space-separated and sentence-cased —
 * only the first word capitalised (e.g. `copse.post-turn-review` → "Post turn
 * review"), with known acronyms left uppercase (`copse.pii-redaction` → "PII
 * redaction"). User plugins with their own human name keep it as-is.
 */
function pluginDisplayName(plugin: import('@shared/types/plugins.ts').PluginSummary): string {
  const raw = plugin.name || plugin.id
  if (plugin.trust === 'first-party') {
    const stripped = raw.startsWith('copse.') ? raw.slice('copse.'.length) : raw
    const words = stripped
      .replace(/[-_.]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (words.length === 0) return raw
    const sentence = words
      .map((word, index) => {
        const lower = word.toLowerCase()
        if (PLUGIN_NAME_ACRONYMS.has(lower)) return lower.toUpperCase()
        // Sentence case: lead word capitalised, the rest lowercase. Plugin ids are
        // kebab-lowercase already, so the lowercasing only matters for ids that
        // arrive mixed-case.
        if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1)
        return lower
      })
      .join(' ')
    return sentence
  }
  return raw
}

/**
 * Whole-app tint (Appearance ▸ Interface tint). The hue is mixed into every
 * neutral surface at a strength that maps to a percentage; `off` disables it.
 * Applied by writing --tint-hue / --tint-amount on the document root, which
 * tokens.css folds into every --bg-* surface (see its --tint-* comment).
 */
export type UiTintStrength = 'off' | 'subtle' | 'medium' | 'strong'
export const DEFAULT_ACCENT_COLOR = '#FF93D0'
export const DEFAULT_TINT_COLOR = '#244C25'
export const DEFAULT_TINT_STRENGTH: UiTintStrength = 'subtle'
const COPSE_SITE_TINT_COLOR = '#002E2B'
const TINT_STRENGTH_AMOUNTS: Record<UiTintStrength, string> = {
  off: '0%',
  subtle: '4%',
  medium: '8%',
  strong: '16%',
}
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

// The tint-strength slider snaps to these ordered levels (index = 0..3).
const UI_TINT_STRENGTHS: readonly UiTintStrength[] = ['off', 'subtle', 'medium', 'strong']
const TINT_STRENGTH_LABELS: Record<UiTintStrength, string> = {
  off: 'Off',
  subtle: 'Subtle',
  medium: 'Medium',
  strong: 'Strong',
}

/** Map a slider value (or an already-internal strength string) to a strength. */
function tintStrengthFromValue(value: unknown): UiTintStrength {
  if (isUiTintStrength(value)) return value
  const index = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return UI_TINT_STRENGTHS[index] ?? DEFAULT_TINT_STRENGTH
}

/** Map a strength back to the slider's current numeric value. */
function tintSliderIndex(strength: UiTintStrength): number {
  const index = UI_TINT_STRENGTHS.indexOf(strength)
  return index >= 0 ? index : UI_TINT_STRENGTHS.indexOf(DEFAULT_TINT_STRENGTH)
}

function accentTextColor(color: string): '#444444' | '#ffffff' {
  const linearChannel = (offset: number): number => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }
  const red = linearChannel(1)
  const green = linearChannel(3)
  const blue = linearChannel(5)
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luminance > 0.179 ? '#444444' : '#ffffff'
}

/** Apply the interaction hue and keep text on solid accent fills readable. */
export function applyUiAccent(color: string): void {
  if (!HEX_COLOR.test(color)) return
  const root = document.documentElement
  root.style.setProperty('--accent-color', color)
  root.style.setProperty('--text-on-accent', accentTextColor(color))
}

export function isUiTintStrength(value: unknown): value is UiTintStrength {
  return value === 'off' || value === 'subtle' || value === 'medium' || value === 'strong'
}

/** Push the tint onto the document root so every surface picks it up at once. */
export function applyUiTint(color: string, strength: UiTintStrength): void {
  const root = document.documentElement
  if (HEX_COLOR.test(color)) {
    root.style.setProperty('--tint-hue', color)
    root.dataset['tintPalette'] =
      color.toLowerCase() === COPSE_SITE_TINT_COLOR.toLowerCase() ? 'copse' : 'custom'
  }
  root.dataset['tintStrength'] = strength
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
interface SettingFieldBase {
  name: string
  /** Whether the save handler writes this field via api.settings.set. */
  save: boolean
}

type SettingField = SettingFieldBase &
  (
    | { kind: 'checkbox'; default: boolean }
    | { kind: 'text'; default: string }
    | { kind: 'number'; default: number }
  )

const SIMPLE_FIELDS: readonly SettingField[] = [
  { name: 'customInstructions', kind: 'text', default: '', save: true },
  { name: 'externalApiSafety', kind: 'checkbox', default: false, save: true },
  { name: 'remoteAgentAutoCreatePR', kind: 'checkbox', default: true, save: true },
  { name: 'remoteAgentWorkOnCurrentBranch', kind: 'checkbox', default: false, save: true },
  { name: 'preferAcpOverCloudAgent', kind: 'checkbox', default: true, save: true },
  { name: 'localSubagentsEnabled', kind: 'checkbox', default: true, save: true },
  {
    name: 'subagentsEnabled',
    kind: 'checkbox',
    default: false,
    save: true,
  },
  { name: 'localTodoItemsEnabled', kind: 'checkbox', default: true, save: true },
  // P5: the master post-turn-review toggle moved to Settings > Plugins
  // (`copse.post-turn-review`); the threshold below stays a top-level setting.
  { name: 'postTurnReviewMinChangedLines', kind: 'number', default: 1, save: true },
  { name: 'bundledCursorSkillsEnabled', kind: 'checkbox', default: true, save: true },
  { name: 'skillExternalLinkWarnings', kind: 'checkbox', default: true, save: true },
  { name: 'skillSandboxGuidance', kind: 'checkbox', default: true, save: true },
  // Built-in browser tools (Electron's bundled Chromium); on by default so the
  // agent renders/screenshots web UIs in-app instead of installing a browser.
  { name: 'browserToolsEnabled', kind: 'checkbox', default: true, save: true },
  // On by default: agent may read open Shells tabs via read_terminal / @shell.
  { name: 'readTerminalEnabled', kind: 'checkbox', default: true, save: true },
  // On by default: clicked links open in the in-app browser pane. Off routes
  // external links to the system browser and marks them with an external icon.
  { name: 'openLinksInBuiltInBrowser', kind: 'checkbox', default: true, save: true },
  { name: 'alertOnInteraction', kind: 'checkbox', default: true, save: true },
  { name: 'alertOnThreadFinished', kind: 'checkbox', default: true, save: true },
  { name: 'alertSystemNotification', kind: 'checkbox', default: true, save: true },
  { name: 'alertSound', kind: 'checkbox', default: true, save: true },
  { name: 'alertBounce', kind: 'checkbox', default: true, save: true },
  { name: 'acpAutoApproveEditsWithBackup', kind: 'checkbox', default: true, save: true },
  { name: 'acpAutoApproveNativeBridgeTools', kind: 'checkbox', default: true, save: true },
  { name: 'worktreeAutoApproveEdits', kind: 'checkbox', default: true, save: true },
  { name: 'acpOverSshEnabled', kind: 'checkbox', default: false, save: true },
  // Experimental, opt-in features (off by default). The MCP-UI artefacts
  // (canvas) toggle moved to Settings > Plugins (`copse.mcp-ui-canvas`).
  { name: 'modelClassifierEnabled', kind: 'checkbox', default: false, save: true },
  { name: 'orchestrationStrategyEnabled', kind: 'checkbox', default: false, save: true },
  // P5: the master model-comparison toggle moved to Settings > Plugins
  // (`copse.model-comparison`); the auto-on-review sub-toggle stays here.
  { name: 'modelComparisonAutoOnReview', kind: 'checkbox', default: false, save: true },
  { name: DEVELOPER_MODE_SETTING, kind: 'checkbox', default: false, save: true },
  // Background tasks moved to Settings > Plugins (`copse.background-tasks`), which
  // also declares the `loopback-bind` sandbox relaxation (issue #1190).
  // The DevTools shortcut toggle moved to Settings > Plugins (`copse.devtools-shortcut`).
  // Loaded here; saved as part of the setSecurity() bundle below.
  { name: 'safetyClassifierEnabled', kind: 'checkbox', default: true, save: false },
  { name: 'autoRunSandboxCommands', kind: 'checkbox', default: true, save: false },
  { name: 'cursorHooksEnabled', kind: 'checkbox', default: false, save: false },
  { name: 'mcpAutoAllowReadOnly', kind: 'checkbox', default: false, save: false },
  { name: 'defaultReadonlyMode', kind: 'checkbox', default: false, save: false },
  { name: 'webAllowUserApproval', kind: 'checkbox', default: true, save: false },
  { name: 'providerAllowUserApproval', kind: 'checkbox', default: true, save: false },
  { name: 'safetyExternalDenyThreshold', kind: 'text', default: '1', save: false },
]

async function loadSimpleFields(form: HTMLFormElement, api: ApiClient): Promise<void> {
  for (const field of SIMPLE_FIELDS) {
    const input = form.elements.namedItem(field.name)
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
      throw new Error(`Settings dialog template is missing ${JSON.stringify(field.name)}`)
    }
    const saved = await api.settings.get(field.name)
    if (field.kind === 'checkbox') {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error(`Settings field ${JSON.stringify(field.name)} must be an input`)
      }
      input.checked = typeof saved === 'boolean' ? saved : field.default
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
  const externalDeny = form.elements.namedItem('safetyExternalDenyThreshold')
  if (!(externalDeny instanceof HTMLInputElement)) {
    throw new Error('Settings dialog template is missing "safetyExternalDenyThreshold"')
  }

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

async function saveSimpleFields(
  data: FormData,
  api: ApiClient,
  dirtyFieldNames: ReadonlySet<string>,
): Promise<void> {
  await Promise.all(
    SIMPLE_FIELDS.filter((field) => field.save && dirtyFieldNames.has(field.name)).map(
      async (field) => {
        if (field.kind === 'checkbox') {
          await api.settings.set(field.name, data.get(field.name) === 'on')
        } else if (field.kind === 'number') {
          const value = formDataString(data, field.name)
          await api.settings.set(field.name, parseNonNegativeInt(value, field.default))
        } else {
          const value = formDataString(data, field.name)
          const trimmed = field.name === 'customInstructions'
          await api.settings.set(field.name, trimmed ? value.trim() : value)
        }
      },
    ),
  )
}

/** Read a text field from FormData, narrowing to string without a cast. */
function formDataString(data: FormData, key: string): string {
  const value = data.get(key)
  return typeof value === 'string' ? value : ''
}

function storedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function storedStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined
}

function inputControl(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLInputElement)) {
    throw new Error(`Settings dialog template is missing input ${JSON.stringify(name)}`)
  }
  return control
}

function selectControl(form: HTMLFormElement, name: string): HTMLSelectElement {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLSelectElement)) {
    throw new Error(`Settings dialog template is missing select ${JSON.stringify(name)}`)
  }
  return control
}

function textareaControl(form: HTMLFormElement, name: string): HTMLTextAreaElement {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLTextAreaElement)) {
    throw new Error(`Settings dialog template is missing textarea ${JSON.stringify(name)}`)
  }
  return control
}

function parseWebAllowedOrigins(value: FormDataEntryValue | null): string[] {
  const text = typeof value === 'string' ? value : ''
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseApprovedProviderHosts(value: FormDataEntryValue | null): string[] {
  const text = typeof value === 'string' ? value : ''
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase().replace(/\.$/, ''))
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
          <button type="button" class="settings-nav-btn" data-section="agent">Agent</button>
          <button type="button" class="settings-nav-btn" data-section="permissions">Permissions</button>
          <button type="button" class="settings-nav-btn" data-section="mcp">MCP servers</button>
          <button type="button" class="settings-nav-btn" data-section="customise">Customise</button>
          <button type="button" class="settings-nav-btn" data-section="storage">Storage</button>
          <button type="button" class="settings-nav-btn" data-section="appearance">Appearance</button>
          <button type="button" class="settings-nav-btn" data-section="ssh">SSH</button>
          <button type="button" class="settings-nav-btn" data-section="experimental">Experimental</button>
        </nav>

        <form class="settings-content">
          <section class="settings-section active" data-section="general">
            <h3>General</h3>
            <p class="settings-section-desc">
              What Copse detected on this machine, the providers it can send work to, and the
              models it picks by default.
            </p>

            <!-- JS-mounted panels sit in a host <div>. Any such host that holds a
                 top-level panel MUST carry class="settings-mount" so its injected
                 fieldset gets the same inter-panel spacing as inline ones: see the
                 .settings-section > .settings-mount > fieldset rule in settings.css. -->
            <div id="settings-env-detect-host" class="settings-mount"></div>

            <div id="settings-providers-host" class="settings-mount"></div>

            <fieldset id="settings-models-section" data-testid="settings-chat-model">
              <legend>Models</legend>
              <p class="settings-fieldset-desc">
                Choose the main chat model and the models used for background tasks. The defaults
                prefer a model running on this machine, but anything from a provider you have set
                up can be selected.
              </p>
              <label>
                Chat model
                <select name="model"></select>
                <span class="field-hint">
                  Default is <strong>Best value (plan / price)</strong>: each new chat window picks
                  the model that gives the most for what it costs on your plan, and sends the turn
                  to that provider. You can pin a specific model here instead, or from the picker
                  beside the chat box. Picking a cloud agent sends each turn to that provider's
                  machines rather than running it here; set one up under Providers.
                </span>
              </label>
              <label>
                Small tasks
                <select name="smallTasksModel"></select>
                <span class="field-hint">
                  Lightweight prompts such as thread titles and follow-up suggestions. Auto prefers
                  an on-device model, then falls back to the chat model.
                </span>
              </label>
              <div id="settings-model-parameters-host"></div>
              <div id="settings-model-routing-host"></div>
            </fieldset>

            <!-- Cloud-agent pieces the Providers panel relocates into whichever
                 provider offers one. The shared run options move with them but stay
                 inside this form either way, so their values always round-trip. -->
            <div id="settings-cloud-agent-templates" hidden>
              <div id="settings-cursor-panel" class="remote-agent-panel">
                <div id="settings-cursor-key-host"></div>
                <p class="field-hint" data-testid="cursor-agents-list-hint">
                  Runs Copse starts belong to this key, so they stay hidden on
                  <a href="${CURSOR_AGENTS_WEB_URL}" target="_blank" rel="noopener noreferrer">cursor.com/agents</a>
                  until you enable <strong>Filter → Source → API</strong> there. Follow-along links
                  in the chat always open the run directly.
                </p>
              </div>
              <div id="settings-claude-panel" class="remote-agent-panel">
                <div id="settings-claude-agent-key-host"></div>
                <p class="field-hint">
                  The Claude cloud agent needs an Anthropic API key plus a GitHub token. The token
                  is only used to clone the repository and push branches; the agent never sees it.
                </p>
              </div>
              <div id="settings-cloud-agent-options">
                <p class="settings-fieldset-desc remote-agent-common-note">
                  A cloud agent runs the whole turn on the provider's machines. The conversation
                  streams back here as normal, but the work happens there: it runs its own tools and
                  pushes commits to a branch on this project's <code>origin</code> repository,
                  branching from your current branch. It never edits the files in this folder, so
                  review its changes in the branch or pull request it links in the reply.
                </p>
                <label class="checkbox-label">
                  <input type="checkbox" name="remoteAgentAutoCreatePR" />
                  Open a pull request automatically when the cloud agent finishes
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" name="remoteAgentWorkOnCurrentBranch" />
                  Push directly to the current branch instead of a new branch
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" name="preferAcpOverCloudAgent" />
                  Offer to switch to Claude on this machine when the cloud agent can’t run (bad key
                  or no credit)
                </label>
              </div>
            </div>
          </section>

          <section class="settings-section" data-section="usage">
            <h3>Usage</h3>
            <p class="settings-section-desc">
              Your subscription plan windows for the accounts you are signed in to, plus estimated
              spend and free on-device token usage across every project. Costs are approximate and
              based on published prices.
            </p>
            <div id="settings-usage-host" class="settings-mount"></div>
            <div id="settings-aa-key-host" class="settings-mount"></div>
          </section>

          <section class="settings-section" data-section="agent">
            <h3>Agent</h3>
            <p class="settings-section-desc">
              Standing instructions for every conversation, the helpers the agent leans on, and the
              skills it can run.
            </p>

            <fieldset>
              <legend>Instructions</legend>
              <label>
                Custom instructions
                <textarea
                  name="customInstructions"
                  rows="4"
                  placeholder="Always-on guidance added to every conversation (e.g. preferred style, conventions)."
                ></textarea>
                <span class="field-hint">
                  Added to every conversation, in every project. A project
                  <code>AGENT.md</code>, <code>AGENTS.md</code>, or <code>CLAUDE.md</code> adds
                  instructions for that project on top of this.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="externalApiSafety" />
                Steer the agent toward safe API usage
              </label>
              <p class="field-hint">
                Reminds the agent to pick compatible dependency versions and never hardcode or log
                secrets when it adds an API call.
              </p>
            </fieldset>

            <fieldset>
              <legend>Helpers</legend>
              <p class="settings-fieldset-desc">
                Extra models the agent can hand work to, so the main model stays focused on the
                task and cheap work stays cheap.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="subagentsEnabled" />
                Hand reading and searching to an exploration helper
              </label>
              <p class="field-hint">
                When on, the main model asks a helper to explore the code and report back a
                summary. When off (the default) it reads and searches the files itself, which
                keeps more detail in view.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="localSubagentsEnabled" />
                Use a model on this machine for exploration when the chat model is in the cloud
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="localTodoItemsEnabled" />
                Use a model on this machine for to-do items marked as local
              </label>
              <label>
                Skip the post-turn review below this many changed lines (1 = only skip an empty
                change, 0 = always review)
                <input
                  type="number"
                  name="postTurnReviewMinChangedLines"
                  min="0"
                  step="1"
                  class="settings-number-input"
                />
              </label>
              <p class="field-hint">
                Turn the review itself on or off under <strong>Plugins</strong>. If it runs on a paid
                model you are asked to approve the spend once per chat; choose a model on this
                machine to review for free.
              </p>
            </fieldset>

            <fieldset>
              <legend>Skills</legend>
              <p class="settings-fieldset-desc">
                Reusable workflows you invoke with <code>/skill-name</code> in the chat input.
                Copse ships a set of them, and each project can add its own.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="bundledCursorSkillsEnabled" />
                Include the skills that ship with Copse (CI, code review, verification, and more)
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="skillExternalLinkWarnings" />
                Warn before running a skill that points at the web
              </label>
              <p class="field-hint">
                When a skill you invoke links to a website, say so up front and require approval
                before the agent fetches, installs, or runs anything from it.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="skillSandboxGuidance" />
                Keep a skill's commands inside the project
              </label>
              <p class="field-hint">
                Reminds the agent that a skill's commands stay inside the project folder, or need
                approval where that cannot be enforced, rather than quietly reaching the network or
                the rest of your machine.
              </p>
            </fieldset>

            <div id="settings-gh-cli-host" class="settings-mount"></div>
          </section>

          <section class="settings-section" data-section="permissions">
            <h3>Permissions</h3>
            <p class="settings-section-desc">
              What the agent is allowed to do without stopping to ask you.
            </p>

            <fieldset>
              <legend>Shell commands</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="autoRunSandboxCommands" />
                Run commands without asking when they stay inside the project folder
              </label>
              <label>
                Also run recognised low-risk commands without asking
                <select name="shellAutoApprovalLevel">
                  ${AUTO_APPROVAL_LEVELS.map(
                    (level) =>
                      `<option value="${level}">${AUTO_APPROVAL_LEVEL_LABELS[level]}</option>`,
                  ).join('')}
                </select>
                <span class="field-hint">
                  Matches a fixed list of command shapes exactly — never a model's judgement, and
                  never anything it doesn't recognise. Reads cover local queries plus
                  <code>git fetch</code> and <code>gh pr view</code> against a remote this project
                  already has configured; a URL never qualifies. Higher levels add local commits,
                  then <code>git push</code> and <code>gh pr create</code>. Force pushes, deleting
                  branches, installs, <code>npx</code>, project scripts like <code>npm test</code>,
                  and anything containing <code>$(…)</code> always ask. Only applies in a trusted
                  project with the setting above turned on. At the two write levels
                  <code>git commit</code>, <code>checkout</code> and <code>push</code> run this
                  project's git hooks — the macOS sandbox contains those, Linux and Windows do not.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="safetyClassifierEnabled" />
                Check commands for danger before running them
              </label>
              <label>
                Block outright above this confidence
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
                <span class="field-hint">
                  Refuse, with no prompt, any command judged this likely to be both dangerous and
                  aimed outside the project. Leave at 1.00 to always ask instead.
                </span>
              </label>
              <label>
                Trusted commands
                <textarea
                  name="trustedShellCommands"
                  rows="5"
                  spellcheck="false"
                  placeholder="xcodebuild"
                ></textarea>
                <span class="field-hint">
                  One command name per line, for tools that are safe but cannot run inside the
                  project folder (for example <code>xcodebuild</code>). These run with no prompt.
                  A line that also does something destructive or reaches the network still asks.
                  Only applies in a project you trust and while the first option above is on.
                </span>
              </label>
            </fieldset>

            <fieldset>
              <legend>File edits</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="acpAutoApproveEditsWithBackup" />
                Let agents on this machine edit files without asking (a backup is taken first)
              </label>
              <p class="field-hint">
                Copse snapshots your uncommitted work before the agent starts, so if an edit
                overwrites something the Changes panel offers a one-click
                <strong>Restore pre-session changes</strong>. Shell commands and web requests still
                ask. Turn off to review every file edit.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="acpAutoApproveNativeBridgeTools" />
                Let agents on this machine use Copse's own tools without asking
              </label>
              <p class="field-hint">
                Copse's tools (GitHub, code search, changes, browser, web fetch) apply their own
                permission checks each time they run, so the extra prompt only asks twice. Turn off
                to be asked anyway.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="worktreeAutoApproveEdits" />
                Skip approval for deletes, renames, and new folders in an isolated worktree
              </label>
              <p class="field-hint">
                A thread on an isolated worktree edits its own checkout on its own branch — your
                files and branch are never touched — so it applies these straight away instead of
                asking. Threads on the shared checkout keep asking. Copse still asks if the file
                changed underneath it or its work could not be backed up. Turn off to review every
                one.
              </p>
            </fieldset>

            <fieldset>
              <legend>Web and terminals</legend>
              <p class="settings-fieldset-desc">
                The agent can only reach the websites listed here. Anything else needs your
                approval first.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="browserToolsEnabled" />
                Let the agent open and screenshot web pages in Copse
              </label>
              <p class="field-hint">
                Uses the browser built into Copse rather than asking you to install a separate one.
                Pages on this machine load straight away; anything else asks.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="readTerminalEnabled" />
                Let the agent read your open Shells tabs
              </label>
              <p class="field-hint">
                When on (the default), the agent can read a Shells tab open in this chat, and you
                can add one to a message with <code>@shell</code>. Turn off to keep your terminals
                private.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="webAllowUserApproval" />
                Ask before allowing a new website
              </label>
              <label>
                Allowed websites
                <textarea
                  name="webAllowedOrigins"
                  rows="6"
                  spellcheck="false"
                  placeholder="https://example.com"
                ></textarea>
                <span class="field-hint">
                  One per line. Whole sites work too, such as
                  <code>https://*.duckduckgo.com</code>. This machine and DuckDuckGo are allowed by
                  default.
                </span>
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="providerAllowUserApproval" />
                Ask before allowing a new provider address
              </label>
              <label>
                Allowed provider addresses
                <textarea
                  name="approvedProviderHosts"
                  rows="4"
                  spellcheck="false"
                  placeholder="api.together.xyz"
                ></textarea>
                <span class="field-hint">
                  Host names only, one per line, that a provider you added yourself may use.
                  Built-in providers and this machine are always allowed. Adding a provider prompts
                  you to approve its address while this is on.
                </span>
              </label>
            </fieldset>
          </section>

          <section class="settings-section" data-section="mcp">
            <h3>MCP servers</h3>
            <p class="settings-section-desc">
              Model Context Protocol servers expose external tools to the agent. This section is
              the whole picture of what Copse talks to over MCP — servers you configured, servers
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
                them — either the plugin is turned off, or it declares servers Copse does not start
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
                Files appended to the system prompt, in precedence order. Global steering
                (<code>~/AGENTS.md</code>, <code>~/.claude/CLAUDE.md</code>) loads first, then
                project <code>AGENT.md</code>/<code>AGENTS.md</code> (cross-tool),
                <code>CLAUDE.md</code> (Claude Code), and always-applied Cursor rules
                (<code>.cursor/rules/*.mdc</code> with <code>alwaysApply: true</code>, plus
                <code>.cursorrules</code>). Auto-attached and manually <code>@</code>-mentioned
                rules also join this list for the turn that activates them.
              </p>
              <div id="sources-instructions-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset>
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
              <legend>Skills</legend>
              <p class="settings-fieldset-desc">
                Skills found on this machine, tagged by where they came from. Hover a row to see
                its path. Choose whether to include the ones that ship with Copse under
                Agent → Skills.
              </p>
              <div id="sources-skills-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

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
                Run Cursor hooks
              </label>
              <p class="field-hint">
                Off by default. Turning this on runs your own scripts while the agent works: every
                tool call it makes can start a matching hook command, with the same rights you
                have on this machine. Project hooks also need you to trust the project, the same
                bar as running its build scripts. A hook that fails never blocks the agent.
              </p>
              <div id="sources-hooks-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
            </fieldset>

            <fieldset id="plugins-fieldset">
              <legend>Plugins</legend>
              <p class="settings-fieldset-desc">
                Every plugin Copse knows about, whatever installed it — shipped with the app,
                added to <code>~/.copse/plugins/</code>, selected as a folder, or installed through
                Cursor. Each row says where it came from and what it contributes. Turning one off
                drops all of its contributions from new work in one action; its stored data and old
                conversation history remain available. Cursor-installed plugins are read-only here
                because Cursor owns their lifecycle. See
                <a href="https://github.com/copse-dev/agent-pane/blob/main/docs/adding-a-plugin.md" target="_blank" rel="noopener noreferrer">how to add a plugin</a>
                for authoring and install steps.
              </p>
              <div class="settings-action-row">
                <button type="button" class="ui-btn ui-btn-secondary" id="plugins-add-btn">
                  Add plugin…
                </button>
                <button type="button" class="ui-btn ui-btn-secondary" id="plugins-reload-btn">
                  Reload
                </button>
                <span class="lmstudio-test-status" id="plugins-reload-status"></span>
              </div>
              <div id="plugins-list" class="plugins-group">
                <span class="plugins-empty">Loading…</span>
              </div>
            </fieldset>

          </section>

          <section class="settings-section" data-section="storage">
            <h3>Storage</h3>
            <p class="settings-section-desc">
              What Copse keeps on disk for this project, and what it costs. Nothing here changes
              how the agent behaves — it is where you go to see what has accumulated and reclaim
              space.
            </p>

            <fieldset>
              <legend>Worktrees</legend>
              <p class="settings-fieldset-desc">
                Linked Git checkouts of this project. Copse creates one per isolated thread so
                agents can work without touching your checkout; each row shows the thread it was
                created for, when it was last used, and what it costs on disk. Deleting one removes
                the directory and, when the branch is fully merged, the branch with it.
              </p>
              <div id="sources-worktrees-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
              <span class="lmstudio-test-status" id="sources-worktrees-status"></span>
            </fieldset>
          </section>

          <section class="settings-section" data-section="appearance">
            <h3>Appearance</h3>
            <p class="settings-section-desc">
              Theme, app icon, interface scale, window layout, and alerts.
            </p>

            <fieldset data-testid="settings-alerts">
              <legend>Alerts</legend>
              <p class="settings-fieldset-desc">
                Choose when Copse should get your attention and how it should alert you. Each
                delivery method is independent.
              </p>
              <span class="settings-field-label">Notify me when</span>
              <label class="checkbox-label">
                <input type="checkbox" name="alertOnInteraction" />
                Thread needs interaction
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="alertOnThreadFinished" />
                Thread finishes
              </label>
              <span class="settings-field-label">Alert me with</span>
              <label class="checkbox-label">
                <input type="checkbox" name="alertSystemNotification" />
                System notification
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="alertSound" />
                Sound
              </label>
              <label class="checkbox-label">
                <input type="checkbox" name="alertBounce" />
                Dock or taskbar animation
              </label>
            </fieldset>

            <fieldset>
              <legend>Display</legend>
              <label>
                Interface scale
                <input type="number" name="uiScale" min="0.75" max="1.5" step="0.05" />
              </label>
              <p class="field-hint">
                Scales UI type and spacing (0.75–1.5). Also adjustable with ⌘+/- (Ctrl+/-), ⌘0, or a
                trackpad pinch.
              </p>
              <label>
                Editor &amp; terminal font size
                <input type="number" name="fontSize" min="12" max="20" step="1" />
              </label>
              <p class="field-hint">
                Monaco and terminal font size in pixels, applied on top of interface scale.
              </p>
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
                horizontally so Projects and chat stay above Explorer, Terminal, Changes, and Plan.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="openLinksInBuiltInBrowser" />
                Open links in the built-in browser
              </label>
              <p class="field-hint">
                When on, links you click in chat, pull requests, and previews open in Copse's own
                browser pane. Turn off to open them in your usual browser instead; external links
                then show an
                <span class="external-link-hint-icon" aria-hidden="true"></span> icon.
              </p>
            </fieldset>

            <fieldset>
              <legend>Interface colours</legend>
              <p class="settings-fieldset-desc">
                Theme, accent colour, and interface tint. Accent colour is used for links, primary
                buttons, selected items, focus indicators, and your chat messages. Interface tint
                adds a separate, subtle wash through neutral surfaces. Both work in light and dark
                themes.
              </p>
              <label>
                Theme
                <select name="theme">
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <!-- Two swatches, one decision each, read side by side: they are
                   the section's only colour choices and comparing them is the
                   whole task. -->
              <div class="settings-swatch-row">
                <label>
                  Accent colour
                  <input type="color" name="uiAccentColor" />
                </label>
                <label>
                  Interface tint colour
                  <input type="color" name="uiTintColor" />
                </label>
              </div>
              <label>
                Interface tint strength
                <span class="slider-row">
                  <input
                    type="range"
                    name="uiTintStrength"
                    min="0"
                    max="3"
                    step="1"
                    list="tint-strength-levels"
                  />
                  <output class="slider-value" for="uiTintStrength">Subtle</output>
                </span>
                <datalist id="tint-strength-levels">
                  <option value="0" label="Off"></option>
                  <option value="1" label="Subtle"></option>
                  <option value="2" label="Medium"></option>
                  <option value="3" label="Strong"></option>
                </datalist>
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
                    <img src="./icon-previews/${variant}.png" alt="" width="88" height="88" />
                  </span>
                  <span class="app-icon-label">${APP_ICON_VARIANT_LABELS[variant]}</span>
                </label>`,
                ).join('')}
              </div>
            </fieldset>
          </section>

          <section class="settings-section" data-section="ssh">
            <h3>SSH</h3>
            <p class="settings-section-desc">
              Work on a remote Linux machine over SSH. Commands, git, search, and files all run
              there while Copse stays on your desktop.
            </p>
            <div id="settings-ssh-workspace-host" class="settings-mount"></div>

            <fieldset>
              <legend>Agents on the remote machine</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="acpOverSshEnabled" />
                Run agents on the remote machine (experimental)
              </label>
              <p class="field-hint">
                When a project is on a remote machine, start the agent there, next to the code,
                instead of leaving it unavailable. The agent has to be installed and signed in on
                that machine already.
              </p>
            </fieldset>
          </section>

          <section class="settings-section" data-section="experimental">
            <h3>Experimental</h3>
            <p class="settings-section-desc">
              Early, opt-in features that are still being explored. They may change or be removed,
              and are off by default.
            </p>

            <fieldset>
              <legend>Model classifier</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="modelClassifierEnabled" />
                Let the agent get a best-fit model recommendation for a task
              </label>
              <p class="field-hint">
                Lets the agent judge how hard a task is and name a model that suits it, so simple
                work goes to a cheap, fast model and the hard problems get a top one. Advice only:
                it never switches the model you are using.
              </p>
            </fieldset>

            <fieldset>
              <legend>Delegating steps</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="orchestrationStrategyEnabled" />
                Let the agent hand implementation steps to a cheaper model
              </label>
              <p class="field-hint">
                The opposite of the advisor: your chat model plans the work and passes each step,
                with the context it needs, to a cheaper and faster model that does the editing.
                Every step comes back with a report and a summary of what changed, so the chat
                model can review it before moving on.
              </p>
              <label class="field-label" for="orchestrationWorkerModel">Worker model</label>
              <select id="orchestrationWorkerModel" name="orchestrationWorkerModel">
                <option value="">(loading…)</option>
              </select>
              <p class="field-hint">
                How to choose the model that carries out the delegated steps — resolved against
                your configured providers each time a step is handed off. Prefer a rule that lands
                cheaper and faster than your chat model.
              </p>
            </fieldset>

            <fieldset>
              <legend>Model comparison</legend>
              <p class="field-hint">
                Reviews your current changes through two models independently, then has a third
                compare their verdicts. Turn it on under <strong>Plugins</strong>, where you also
                choose how the three models are picked — they always resolve to different models,
                so there is something to compare. A run makes up to three model calls, so it asks
                before spending on a paid model.
              </p>
              <label class="checkbox-label">
                <input type="checkbox" name="modelComparisonAutoOnReview" />
                Run the comparison automatically after editing turns
              </label>
              <p class="field-hint">
                When on, the comparison runs as part of the post-turn review, still asking before
                it spends. When off, ask for it when you want it.
              </p>
            </fieldset>

            <fieldset>
              <legend>Developer mode</legend>
              <label class="checkbox-label">
                <input type="checkbox" name="developerMode" />
                Enable developer mode
              </label>
              <p class="field-hint">
                Shows Hooks in Sources and the conversation diagnostics menu. The optional
                <code>Ctrl+Shift+I</code> shortcut is a separate plugin.
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
  const sshWorkspaceSection = createSshWorkspaceSection(api, {
    // Live-persist toggles must wake listeners (e.g. projects "+ Remote" button)
    // without requiring the dialog Save button.
    onChanged: (): void => {
      store.emit('settings_changed')
    },
  })
  qsRequired(overlay, '#settings-ssh-workspace-host').append(sshWorkspaceSection.root)

  const envKeyDetectSection = createEnvKeyDetectSection(api, {
    legend: 'Detected settings',
    onImported: () => {
      void cursorKeySection.refreshKeyStatus()
      void providersPanel.refresh()
    },
  })
  qsRequired(overlay, '#settings-env-detect-host').append(envKeyDetectSection.root)

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

  // Metadata-service key (not an LLM provider): live Intelligence Index data
  // for the model value map on the Usage page. No validation endpoint.
  const aaKeySection = createApiKeysSection(api, {
    legend: 'Model intelligence data',
    providers: ['artificial-analysis'],
    validateOnInput: false,
  })
  qsRequired(overlay, '#settings-aa-key-host').append(aaKeySection.root)

  // One Providers panel covers every way Copse can reach a model: API keys, cloud
  // agents, agents installed on this machine, and model servers you run yourself.
  // The cloud-agent auth panels and their shared run options are built in the
  // template above (their checkboxes must live in this form to round-trip) and
  // relocated by the panel into whichever provider offers a cloud agent. LM Studio
  // keeps its bespoke server UI as a native local provider; the dialog holds onto
  // that handle for getUrl()/saveConnection() in the security-bundle save below.
  const lmStudioSection = createLmStudioSection(api, { showInstallGuide: false })
  const providersPanel = createProvidersPanel(api, {
    nativeLocalProviders: [
      {
        id: 'lmstudio',
        label: 'LM Studio',
        element: lmStudioSection.root,
        refresh: (): Promise<void> => lmStudioSection.refreshDetection(),
      },
    ],
    cloudAgents: [
      {
        vendor: 'cursor',
        element: qsRequired(overlay, '#settings-cursor-panel'),
        keySlugs: ['cursor'],
      },
      {
        vendor: 'anthropic',
        element: qsRequired(overlay, '#settings-claude-panel'),
        keySlugs: ['anthropic', 'github'],
      },
    ],
    cloudAgentOptions: qsRequired(overlay, '#settings-cloud-agent-options'),
  })
  qsRequired(overlay, '#settings-providers-host').append(providersPanel.root)

  const ghCliSection = createGhCliSection(api)
  qsRequired(overlay, '#settings-gh-cli-host').append(ghCliSection.root)

  const modelRoutingSection = createModelRoutingSection(api, { modelScope: 'all' })
  qsRequired(overlay, '#settings-model-routing-host').append(modelRoutingSection.root)

  // Sits directly under the chat-model picker and follows it: the parameters
  // belong to the selected model, so switching models re-renders the controls.
  const modelParametersSection = createModelParametersSection(api.settings)
  qsRequired(overlay, '#settings-model-parameters-host').append(modelParametersSection.root)

  const settingsModelPickers = {
    model: mountModelSelectPicker(qsRequired<HTMLSelectElement>(overlay, 'select[name="model"]'), {
      loadOptions: (current) => fetchModelOptions(api, current, { includeBestValue: true }),
      ariaLabel: 'Chat model',
      loadOnMount: false,
    }),
    smallTasksModel: mountModelSelectPicker(
      qsRequired<HTMLSelectElement>(overlay, 'select[name="smallTasksModel"]'),
      {
        loadOptions: (current) => fetchSmallTasksModelOptions(api, current),
        ariaLabel: 'Small tasks model',
        loadOnMount: false,
      },
    ),
    // Like the plugin model fields, the delegated-step worker selects a rule
    // rather than a model — the delegation happens mid-task, not now.
    orchestrationWorkerModel: mountModelSelectPicker(
      qsRequired(overlay, '#orchestrationWorkerModel'),
      {
        loadOptions: (current) => fetchDynamicModelOptions(current),
        ariaLabel: 'Worker model',
        loadOnMount: false,
      },
    ),
  }

  const usageSection = createUsageSection(api, store, closeSettingsDialog)
  qsRequired(overlay, '#settings-usage-host').append(usageSection.root)

  const navBtns = overlay.querySelectorAll<HTMLButtonElement>('.settings-nav-btn')
  const sections = overlay.querySelectorAll<HTMLElement>('.settings-section')
  const contentEl = qsRequired(overlay, '.settings-content')
  const settingsForm = qsRequired<HTMLFormElement>(overlay, 'form')
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

  interface AppearancePreview {
    theme: 'light' | 'dark'
    accentColor: string
    tintColor: string
    tintStrength: UiTintStrength
  }

  const dirtyFieldNames = new Set<string>()
  let cursorKeysDirty = false
  let claudeAgentKeysDirty = false
  let aaKeysDirty = false
  let providersDirty = false
  let lmStudioDirty = false
  let appearanceBaseline: AppearancePreview | null = null
  let appearanceCommitted = false

  function resetDirtyState(): void {
    dirtyFieldNames.clear()
    cursorKeysDirty = false
    claudeAgentKeysDirty = false
    aaKeysDirty = false
    providersDirty = false
    lmStudioDirty = false
  }

  function currentAppearance(): AppearancePreview {
    const root = document.documentElement
    const accentColor = root.style.getPropertyValue('--accent-color').trim()
    const tintColor = root.style.getPropertyValue('--tint-hue').trim()
    const tintStrength = root.dataset['tintStrength']
    return {
      theme: store.getState().theme,
      accentColor: HEX_COLOR.test(accentColor) ? accentColor : DEFAULT_ACCENT_COLOR,
      tintColor: HEX_COLOR.test(tintColor) ? tintColor : DEFAULT_TINT_COLOR,
      tintStrength: isUiTintStrength(tintStrength) ? tintStrength : DEFAULT_TINT_STRENGTH,
    }
  }

  function applyThemePreview(theme: 'light' | 'dark'): void {
    document.documentElement.dataset['theme'] = theme
    if (store.getState().theme === theme) return
    store.setState({ theme })
    store.emit('theme_changed', theme)
  }

  function applyAppearancePreview(preview: AppearancePreview): void {
    applyThemePreview(preview.theme)
    applyUiAccent(preview.accentColor)
    applyUiTint(preview.tintColor, preview.tintStrength)
  }

  function previewAppearanceFromForm(): void {
    const themePreference = selectControl(settingsForm, 'theme').value
    const accentColor = inputControl(settingsForm, 'uiAccentColor').value
    const tintColor = inputControl(settingsForm, 'uiTintColor').value
    const tintStrength = tintStrengthFromValue(inputControl(settingsForm, 'uiTintStrength').value)
    applyAppearancePreview({
      theme: resolveTheme(isThemePreference(themePreference) ? themePreference : 'dark'),
      accentColor: HEX_COLOR.test(accentColor) ? accentColor : DEFAULT_ACCENT_COLOR,
      tintColor: HEX_COLOR.test(tintColor) ? tintColor : DEFAULT_TINT_COLOR,
      tintStrength,
    })
  }

  function markDirtyTarget(target: EventTarget | null): void {
    if (!(target instanceof HTMLElement)) return
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    ) {
      if (target.name) dirtyFieldNames.add(target.name)
    }

    if (cursorKeySection.root.contains(target)) cursorKeysDirty = true
    else if (claudeAgentKeySection.root.contains(target)) claudeAgentKeysDirty = true
    else if (aaKeySection.root.contains(target)) aaKeysDirty = true
    else if (lmStudioSection.root.contains(target)) lmStudioDirty = true
    else if (providersPanel.root.contains(target)) providersDirty = true
  }

  for (const name of ['theme', 'uiAccentColor', 'uiTintColor', 'uiTintStrength']) {
    const control = settingsForm.elements.namedItem(name)
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
      throw new Error(
        `Settings dialog template is missing appearance control ${JSON.stringify(name)}`,
      )
    }
    const preview = (): void => {
      dirtyFieldNames.add(name)
      previewAppearanceFromForm()
    }
    control.addEventListener('input', preview)
    control.addEventListener('change', preview)
  }

  // Opening the dialog runs a long serial chain of IPC round-trips to populate
  // every section. Run each stage under its own catch so one failure is named
  // and non-fatal rather than silently stranding every stage after it, and stamp
  // the failed stage names on the overlay so a DOM dump (the e2e failure
  // artifacts) records what never got populated.
  const failedRefreshStages: string[] = []
  async function refreshStage(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (err) {
      failedRefreshStages.push(name)
      overlay.dataset['settingsRefreshFailed'] = failedRefreshStages.join(',')
      console.error(`[settings] open refresh stage "${name}" failed`, err)
    }
  }

  const developerModeInput = qsRequired<HTMLInputElement>(
    overlay,
    `input[name="${DEVELOPER_MODE_SETTING}"]`,
  )
  const hooksEnabledInput = qsRequired<HTMLInputElement>(
    overlay,
    'input[name="cursorHooksEnabled"]',
  )
  const hooksFieldset = qsRequired(overlay, '[data-developer-only="hooks"]')

  // Never hide an already-enabled security-sensitive feature: it must remain
  // reachable so the user can turn its execution gate back off.
  function syncDeveloperOnlySettings(): void {
    hooksFieldset.hidden = !developerModeInput.checked && !hooksEnabledInput.checked
  }

  developerModeInput.checked = store.getState().developerMode
  syncDeveloperOnlySettings()

  function showSection(id: SettingsSection): void {
    activeSection = id
    navBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset['section'] === id))
    sections.forEach((sec) => sec.classList.toggle('active', sec.dataset['section'] === id))
    renderNavSubheadings(id)
  }

  // The open section's group headings, mirrored into the sidebar under its row.
  // General and Appearance are several screens tall, so the nav doubles as that
  // section's contents: what is on this page, and a click to jump to it. Only
  // the open section expands, and the list is read back off the DOM each time —
  // so a group that is hidden (developer-only) or mounted by a panel never has
  // to be registered in a second place to show up here.
  let navSubheadings: HTMLElement | null = null

  function clearNavSubheadings(): void {
    navSubheadings?.remove()
    navSubheadings = null
  }

  function renderNavSubheadings(id: SettingsSection): void {
    clearNavSubheadings()
    const navBtn = Array.from(navBtns).find((btn) => btn.dataset['section'] === id)
    const section = Array.from(sections).find((sec) => sec.dataset['section'] === id)
    if (!navBtn || !section) return
    const list = document.createElement('div')
    list.className = 'settings-nav-subheadings'
    for (const block of topLevelBlocks(section)) {
      if (block.hidden) continue
      const label = block.querySelector('legend')?.textContent.trim()
      if (!label) continue
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'settings-nav-subheading'
      btn.textContent = label
      btn.addEventListener('click', () => {
        block.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      list.append(btn)
    }
    if (list.childElementCount === 0) return
    navBtn.after(list)
    navSubheadings = list
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
      // `restoreLiftedBlocks()` above returns every lifted block to the marker
      // left in its section. Anything still parked here lost its marker, and the
      // `replaceChildren()` below is about to destroy it — taking a whole
      // fieldset out of its section for the life of the renderer, which reads
      // downstream as "that setting isn't displayed". Name it before it goes.
      for (const orphan of Array.from(searchResults.children)) {
        console.error(
          '[settings] search results still held a block after restore:',
          orphan.querySelector('legend')?.textContent ?? orphan.className,
        )
      }
      searchResults.replaceChildren()
      showSection(activeSection)
      return
    }

    // Pull in the lazily-loaded section content (providers, SSH hosts, sources)
    // so matched blocks render fully rather than as an empty shell.
    if (!searchContentLoaded) {
      searchContentLoaded = true
      void providersPanel.refresh()
      void sshWorkspaceSection.refresh()
      void refreshSources()
    }

    contentEl.classList.add('settings-searching')
    // Results are lifted out of their sections, so the open section's contents
    // list no longer describes what is on screen. Drop it until search clears.
    clearNavSubheadings()
    const matches: { node: HTMLElement; rank: number }[] = []
    sections.forEach((sec) => {
      for (const block of topLevelBlocks(sec)) {
        if (block.hidden) continue
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
      const id = btn.dataset['section']
      if (isSettingsSection(id)) {
        // Selecting a section is an explicit exit from search results.
        if (searchInput.value) {
          searchInput.value = ''
          applySearch('')
        }
        showSection(id)
        if (id === 'usage') void usageSection.refresh()
        // Defer disk scans until each tab is opened, so users who never visit them
        // don't trigger an fs walk (Sources) on open. The Providers panel defers
        // its own device scan until an agent block is actually shown.
        if (id === 'ssh') void sshWorkspaceSection.refresh()
        if (id === 'customise') {
          void refreshSources()
          void refreshPlugins()
        }
        if (id === 'storage') void refreshWorktrees()
        // Plugin toggles and config edits both change what this section claims,
        // and the open-time staged refresh already ran by the time a user comes
        // back to it — so re-read on entry rather than showing a stale account
        // of what Copse is connected to.
        if (id === 'mcp') {
          void refreshMcpServers()
          void refreshDeclaredMcpServers()
        }
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
    opts: {
      badgeClass?: string | undefined
      /** Extra badges rendered after the scope badge (e.g. unsupported / error). */
      extraBadges?: Array<{ text: string; className: string }>
      /** Native tooltip (also used when hover-detail CSS is unavailable). */
      titleAttr?: string | undefined
      /** Path/origin shown only while the row is hovered or focused. */
      hoverDetail?: string | undefined
    } = {},
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'sources-row'
    if (opts.titleAttr) row.title = opts.titleAttr
    const header = document.createElement('div')
    header.className = 'sources-row-header'
    // Title + optional hover path share one flex slot so a long origin cannot
    // inflate the row / settings scrollport (min-content of a bare path would
    // otherwise win over the section width).
    const primary = document.createElement('div')
    primary.className = 'sources-row-primary'
    const titleEl = document.createElement('span')
    titleEl.className = 'sources-row-title'
    titleEl.textContent = title
    primary.append(titleEl)
    // Origin sits in the primary gutter (title → badge) on hover so the row
    // height never grows; long paths ellipsize from the left. `<bdi>` keeps
    // the path LTR so a leading `/` doesn't flip to the end under `direction:
    // rtl` (same left-elide trick as `.git-change-path`).
    if (opts.hoverDetail) {
      const hoverEl = document.createElement('span')
      hoverEl.className = 'sources-row-hover-detail'
      const pathEl = document.createElement('bdi')
      pathEl.textContent = opts.hoverDetail
      hoverEl.append(pathEl)
      primary.append(hoverEl)
    }
    header.append(primary)
    if (badge) {
      const badgeEl = document.createElement('span')
      badgeEl.className = opts.badgeClass ? `sources-badge ${opts.badgeClass}` : 'sources-badge'
      badgeEl.textContent = badge
      header.append(badgeEl)
    }
    for (const extra of opts.extraBadges ?? []) {
      const badgeEl = document.createElement('span')
      badgeEl.className = `sources-badge ${extra.className}`
      badgeEl.textContent = extra.text
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

  /** One Sources → Hooks row: event + scope/unsupported/error badges + command. */
  function makeHookRow(h: import('@shared/types/hooks.ts').HookSummary): HTMLElement {
    const extraBadges: Array<{ text: string; className: string }> = []
    if (h.supported === false) {
      extraBadges.push({ text: 'unsupported', className: 'sources-badge-unsupported' })
    }
    // The `sandbox: false` escape (F3, decision 7) runs the hook OUTSIDE the
    // project sandbox — badge it so the user sees the elevated risk they granted.
    if (h.sandbox === false) {
      extraBadges.push({ text: 'outside sandbox', className: 'sources-badge-unsandboxed' })
    }
    if (h.lastError) {
      extraBadges.push({ text: 'error', className: 'sources-badge-error' })
    }
    const familyLabel =
      h.family === 'claude' ? 'Claude Code' : h.family === 'copse' ? 'Copse' : 'Cursor'
    const title = h.family === 'claude' && h.matcher ? `${h.event} · ${h.matcher}` : h.event
    const detail = `${familyLabel} · ${h.command}`
    const row = makeSourceRow(title, h.scope, detail, {
      badgeClass: h.scope === 'project' ? 'sources-badge-project' : undefined,
      extraBadges,
    })
    if (h.lastError) {
      const errorEl = document.createElement('div')
      errorEl.className = 'sources-row-error'
      errorEl.textContent = `Last run failed: ${h.lastError}`
      row.append(errorEl)
    }
    addHookTester(row, h)
    return row
  }

  /**
   * Wire the G2 dry-run tester onto a hook row: a "Test" button that runs the
   * hook once against a synthetic payload for its event and shows
   * stdin/stdout/stderr/exit/duration + parse_ok + outcome summary. The dry run
   * never mutates live agent state (see `src/main/services/hooks/dry-run.ts`).
   */
  function addHookTester(row: HTMLElement, h: import('@shared/types/hooks.ts').HookSummary): void {
    const header = row.querySelector('.sources-row-header')
    if (!header) return
    const testBtn = document.createElement('button')
    testBtn.type = 'button'
    testBtn.className = 'sources-hook-test-btn'
    testBtn.textContent = 'Test'
    testBtn.title = 'Dry-run this hook against a synthetic payload for its event'
    header.append(testBtn)

    const result = document.createElement('div')
    result.className = 'hook-test'
    result.hidden = true
    row.append(result)

    testBtn.addEventListener('click', () => {
      void runHookTest(h, testBtn, result)
    })
  }

  async function runHookTest(
    h: import('@shared/types/hooks.ts').HookSummary,
    btn: HTMLButtonElement,
    result: HTMLElement,
  ): Promise<void> {
    btn.disabled = true
    btn.textContent = 'Testing…'
    result.hidden = false
    result.innerHTML = ''
    const pending = document.createElement('div')
    pending.className = 'hook-test-summary'
    pending.textContent = 'Running dry-run…'
    result.append(pending)
    try {
      const req: import('@shared/types/hooks.ts').HookTestRequest = {
        family: h.family,
        event: h.event,
        command: h.command,
        source: h.source,
        scope: h.scope,
        ...(h.sandbox !== undefined ? { sandbox: h.sandbox } : {}),
      }
      const res = await api.hooks.test(req)
      renderHookTestResult(result, res)
    } catch {
      result.innerHTML = ''
      const err = document.createElement('div')
      err.className = 'hook-test-summary hook-test-error'
      err.textContent = 'Dry-run failed to start.'
      result.append(err)
    } finally {
      btn.disabled = false
      btn.textContent = 'Test'
    }
  }

  /** Render one `hooks:test` result: summary chips + labeled stdin/stdout/stderr streams. */
  function renderHookTestResult(
    container: HTMLElement,
    res: import('@shared/types/hooks.ts').HookTestResult,
  ): void {
    container.innerHTML = ''
    if (!res.ran) {
      const notice = document.createElement('div')
      notice.className = 'hook-test-summary hook-test-error'
      notice.textContent = res.error ?? 'This hook could not be dry-run.'
      container.append(notice)
      return
    }

    const summary = document.createElement('div')
    summary.className = 'hook-test-summary'
    const chips: string[] = []
    if (res.wireEvent) chips.push(`event ${res.wireEvent}`)
    if (res.timedOut) chips.push('timed out')
    else if (res.spawnError) chips.push('failed to start')
    chips.push(
      `exit ${res.exitCode === null || res.exitCode === undefined ? 'unknown' : String(res.exitCode)}`,
    )
    chips.push(`${String(res.durationMs ?? 0)} ms`)
    chips.push(res.parseOk ? 'parsed ok' : 'parse failed')
    if (res.sandboxed) chips.push('sandboxed')
    for (const text of chips) {
      const chip = document.createElement('span')
      chip.className = 'hook-test-chip'
      chip.textContent = text
      summary.append(chip)
    }
    container.append(summary)

    if (res.outcomeSummary) {
      const outcome = document.createElement('div')
      outcome.className = 'hook-test-outcome'
      outcome.textContent = `Outcome: ${res.outcomeSummary}`
      container.append(outcome)
    }

    appendHookTestStream(container, 'stdin', res.stdin ?? '')
    appendHookTestStream(container, 'stdout', res.stdout ?? '')
    appendHookTestStream(container, 'stderr', res.stderr ?? '')
  }

  function appendHookTestStream(container: HTMLElement, label: string, text: string): void {
    const block = document.createElement('div')
    block.className = 'hook-test-stream'
    const heading = document.createElement('div')
    heading.className = 'hook-test-stream-label'
    heading.textContent = label
    const pre = document.createElement('pre')
    pre.textContent = text.length > 0 ? text : '(empty)'
    if (text.length === 0) pre.classList.add('hook-test-stream-empty')
    block.append(heading, pre)
    container.append(block)
  }

  /** A hooks.json authoring problem (unknown event, bad entry, malformed file). */
  function makeHookWarningRow(
    w: import('@shared/types/hooks.ts').HookValidationWarning,
  ): HTMLElement {
    const row = makeSourceRow(w.message, w.scope, w.source, {
      badgeClass: w.scope === 'project' ? 'sources-badge-project' : undefined,
      extraBadges: [{ text: 'warning', className: 'sources-badge-warning' }],
    })
    row.classList.add('sources-row-warning')
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

  /** Coarse "when", accurate enough for a list that is scanned, not audited. */
  function relativeTime(value: number): string {
    const elapsed = Date.now() - value
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour
    if (elapsed < 0) return 'just now'
    if (elapsed < minute) return 'just now'
    if (elapsed < hour) return `${String(Math.floor(elapsed / minute))}m ago`
    if (elapsed < day) return `${String(Math.floor(elapsed / hour))}h ago`
    if (elapsed < 30 * day) return `${String(Math.floor(elapsed / day))}d ago`
    return new Date(value).toLocaleDateString()
  }

  /**
   * What a worktree is *for*, in one word. A checkout with a live turn in it
   * cannot be deleted at all; one whose thread has gone (or stopped pointing at
   * it) is the case worth reclaiming, so both are said plainly rather than left
   * for the user to infer from the detail line.
   */
  function worktreeBadge(entry: WorktreeInventoryEntry): {
    text: string
    className: string | undefined
  } {
    if (entry.usage?.running) return { text: 'in use', className: 'sources-badge-project' }
    if (!entry.managed) return { text: 'external', className: undefined }
    if (!entry.usage) return { text: 'orphaned', className: 'sources-badge-warning' }
    if (!entry.usage.linked) return { text: 'released', className: 'sources-badge-warning' }
    if (entry.usage.archived) return { text: 'archived thread', className: undefined }
    return { text: 'thread', className: undefined }
  }

  function worktreeDetail(entry: WorktreeInventoryEntry): string {
    const bits: string[] = []
    if (entry.usage) bits.push(`Thread “${entry.usage.title}”`)
    else if (entry.managed) bits.push('No thread on record')
    else bits.push('Created outside Copse')
    if (entry.lastUsedAt !== null) bits.push(`last used ${relativeTime(entry.lastUsedAt)}`)
    if (entry.createdAt !== null) bits.push(`created ${relativeTime(entry.createdAt)}`)
    return bits.join(' · ')
  }

  /** The row, plus the slot its measured size lands in once `worktrees:size` answers. */
  function makeWorktreeRow(entry: WorktreeInventoryEntry): {
    row: HTMLElement
    size: HTMLElement
  } {
    const badge = worktreeBadge(entry)
    const extraBadges: Array<{ text: string; className: string }> = []
    if (entry.changedCount !== null && entry.changedCount > 0) {
      extraBadges.push({
        text: `${String(entry.changedCount)} uncommitted`,
        className: 'sources-badge-warning',
      })
    }
    if (entry.merged === false) {
      extraBadges.push({ text: 'unmerged', className: 'sources-badge-warning' })
    }
    if (entry.detached) {
      extraBadges.push({ text: 'detached HEAD', className: 'sources-badge-unsupported' })
    }
    if (entry.locked !== null) {
      extraBadges.push({ text: 'locked', className: 'sources-badge-unsupported' })
    }

    const row = makeSourceRow(entry.branch ?? entry.path, badge.text, worktreeDetail(entry), {
      ...(badge.className ? { badgeClass: badge.className } : {}),
      extraBadges,
      titleAttr: entry.path,
      hoverDetail: entry.path,
    })
    row.dataset['worktreePath'] = entry.path

    // Size arrives from a second call per row (`worktrees:size` walks the whole
    // checkout), so the row reserves its slot rather than reflowing later.
    const size = document.createElement('span')
    size.className = 'sources-worktree-size'
    size.textContent = 'sizing…'
    row.querySelector('.sources-row-detail')?.append(' · ', size)

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'sources-worktree-delete-btn'
    removeBtn.textContent = 'Delete'
    if (entry.usage?.running) {
      removeBtn.disabled = true
      removeBtn.title = 'An agent turn is running in this worktree'
    } else {
      removeBtn.title = 'Remove this linked checkout from disk'
    }
    removeBtn.addEventListener('click', () => {
      void removeWorktree(entry, removeBtn)
    })
    row.querySelector('.sources-row-header')?.append(removeBtn)
    return { row, size }
  }

  /** Fill in each row's on-disk size, one checkout at a time so the walks don't pile up. */
  async function fillWorktreeSizes(
    projectId: string,
    targets: Array<{ entry: WorktreeInventoryEntry; size: HTMLElement }>,
  ): Promise<void> {
    for (const target of targets) {
      // A refresh mid-walk detaches the row it was measuring; dropping the
      // answer is right, and cheaper than cancelling the call.
      if (!target.size.isConnected) continue
      try {
        const size = await api.worktrees.size(projectId, target.entry.path)
        target.size.textContent = size.truncated
          ? `over ${formatByteSize(size.bytes)}`
          : formatByteSize(size.bytes)
      } catch {
        target.size.textContent = 'size unavailable'
      }
    }
  }

  /**
   * Delete one checkout. The first confirmation covers the directory; a second
   * one appears only when Git reports content that would be destroyed with it,
   * and lists what that content is — the state is re-read at delete time, so a
   * checkout the agent dirtied since the list rendered still stops here.
   */
  async function removeWorktree(
    entry: WorktreeInventoryEntry,
    button: HTMLButtonElement,
  ): Promise<void> {
    const projectId = store.getState().activeProjectId
    const statusEl = qsRequired(overlay, '#sources-worktrees-status')
    if (!projectId) return
    const name = entry.branch ?? entry.path
    const consequences = [entry.path]
    if (entry.usage?.linked) {
      consequences.push(`Thread “${entry.usage.title}” will continue in the project checkout.`)
    }
    if (entry.merged === false && entry.branch) {
      consequences.push(`Branch ${entry.branch} has unmerged commits and will be kept.`)
    }
    const confirmed = await showConfirmDialog({
      message: `Delete worktree ${name}?`,
      detail: consequences.join('\n'),
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return

    button.disabled = true
    statusEl.textContent = 'Deleting…'
    try {
      let result = await api.worktrees.remove(projectId, entry.path, false)
      if (result.status === 'blocked-dirty') {
        const shown = result.changed.slice(0, 10)
        const rest = result.changed.length - shown.length
        const forced = await showConfirmDialog({
          message: `Discard ${String(result.changed.length)} uncommitted file${
            result.changed.length === 1 ? '' : 's'
          }?`,
          detail: [...shown, ...(rest > 0 ? [`…and ${String(rest)} more`] : [])].join('\n'),
          confirmLabel: 'Delete anyway',
          danger: true,
        })
        if (!forced) {
          statusEl.textContent = 'Kept.'
          button.disabled = false
          return
        }
        result = await api.worktrees.remove(projectId, entry.path, true)
      }
      if (result.status === 'blocked-running') {
        statusEl.textContent = 'That worktree has an agent turn running in it.'
        button.disabled = false
        return
      }
      if (result.status === 'blocked-dirty') {
        statusEl.textContent = 'Git still reports uncommitted work in that worktree.'
        button.disabled = false
        return
      }
      await refreshWorktrees(
        result.branchDeleted ? `Deleted ${name} and its branch.` : `Deleted ${name}.`,
      )
    } catch (error) {
      statusEl.textContent = errorMessage(error)
      button.disabled = false
    }
  }

  /**
   * `status` survives the reload that follows a delete — the list re-renders
   * without the row, and the line saying what happened to it has to outlive
   * that, or the only feedback for a destructive action flashes and is gone.
   */
  async function refreshWorktrees(status = ''): Promise<void> {
    const statusEl = qsRequired(overlay, '#sources-worktrees-status')
    const projectId = store.getState().activeProjectId
    if (!projectId) {
      fillSourceList('#sources-worktrees-list', [], 'Open a project to see its worktrees.')
      return
    }
    try {
      const entries = await api.worktrees.list(projectId)
      const rendered = entries.map((entry) => ({ entry, ...makeWorktreeRow(entry) }))
      fillSourceList(
        '#sources-worktrees-list',
        rendered.map((item) => item.row),
        'No worktrees. Copse creates one when a thread runs in its own checkout.',
      )
      statusEl.textContent = status
      await fillWorktreeSizes(projectId, rendered)
    } catch (error) {
      fillSourceList('#sources-worktrees-list', [], 'Could not list worktrees.')
      statusEl.textContent = errorMessage(error)
    }
  }

  async function refreshSources(): Promise<void> {
    const statusEl = qsRequired(overlay, '#sources-reload-status')
    statusEl.textContent = 'Loading…'
    try {
      const [instructions, cursorRules, skills, hooks] = await Promise.all([
        api.instructions.list(),
        api.cursorRules.list(),
        api.skills.list(),
        api.hooks.list(),
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

      const kindLabel: Record<string, string> = {
        always: 'always',
        auto: 'auto',
        agent: 'agent',
        manual: 'manual',
      }
      fillSourceList(
        '#sources-cursor-rules-list',
        cursorRules.map((r) => {
          const bits = [`${String(r.bytes)} B`]
          if (r.globs?.length) bits.push(`globs: ${r.globs.join(', ')}`)
          if (r.description) bits.push(r.description)
          bits.push(r.path)
          return makeSourceRow(r.name, kindLabel[r.kind] ?? r.kind, bits.join(' · '), {
            badgeClass:
              r.kind === 'always'
                ? 'sources-badge-project'
                : r.kind === 'auto'
                  ? 'sources-badge-auto'
                  : undefined,
          })
        }),
        'No Cursor rules (add .cursor/rules/*.mdc or a legacy .cursorrules file).',
      )

      fillSourceList(
        '#sources-skills-list',
        skills.map((s) =>
          makeSourceRow(s.name, s.source, s.description || null, {
            badgeClass: s.source === 'project' ? 'sources-badge-project' : undefined,
            // Keep the resting list uncluttered: path lives on hover (and as a
            // native tooltip fallback). Description stays as the always-visible
            // detail; when a skill has none, the hover line is the only path.
            titleAttr: s.skillPath,
            hoverDetail: s.skillPath,
          }),
        ),
        'No skills discovered.',
      )

      fillSourceList(
        '#sources-hooks-list',
        [...hooks.warnings.map(makeHookWarningRow), ...hooks.hooks.map(makeHookRow)],
        'No Cursor or Claude Code hooks configured.',
      )

      statusEl.textContent = ''
    } catch {
      statusEl.textContent = 'Failed to load sources.'
    }
  }

  // The advisor model now lives with the `copse.advisor-strategy` plugin (Settings
  // → Plugins), so its select + pairing-hint elements are created by
  // `refreshPlugins()` (in `makePluginRow`) and handed to `updateAdvisorPairHint`
  // via these refs — both null until the plugins list has rendered; the executor
  // is still the global chat-model select in the General section.
  let advisorModelSelectEl: HTMLSelectElement | null = null
  let advisorPairHintEl: HTMLElement | null = null
  // A plugin `model` field loads the live catalogue asynchronously through the
  // shared searchable picker. Its refresh promise is stashed so the advisor row
  // can re-grade its pairing hint once the selected value has settled.
  const modelFieldPopulated = new WeakMap<HTMLSelectElement, Promise<void>>()

  /**
   * Render one plugin row for the Settings → Plugins list (P3 of
   * docs/plans/hooks-and-feature-packs.md). Each row shows the plugin's name and
   * version, its trust tier, an enable/disable toggle, an enumeration of what
   * the plugin contributes (tools / hooks / prompt blocks / panels), and any
   * plugin-scoped settings fields declared by its manifest. Toggling `enabled`
   * calls `plugins:setEnabled`, which flips the shared `PluginRegistry` flag
   * atomically (P1 contract) and persists to `electron-store`.
   */
  function makePluginRow(plugin: import('@shared/types/plugins.ts').PluginSummary): HTMLElement {
    const row = document.createElement('div')
    row.className = 'plugin-row'
    row.dataset['pluginId'] = plugin.id
    row.dataset['enabled'] = plugin.enabled ? 'true' : 'false'

    const header = document.createElement('div')
    header.className = 'plugin-row-header'

    // A plugin is a thing you install, so it gets a mark like one. First-party
    // plugins carry the Copse glyph itself (the real asset, not a redraw); a
    // user-installed plugin must not, or a sideloaded plugin would wear our badge
    // of trust — it gets a neutral tile with its own initial instead.
    const icon = document.createElement('span')
    icon.className = 'plugin-icon'
    icon.setAttribute('aria-hidden', 'true')
    if (plugin.trust === 'first-party') {
      icon.classList.add('plugin-icon-copse')
      const mark = document.createElement('img')
      mark.src = './brand-mark.svg'
      mark.alt = ''
      mark.width = 40
      mark.height = 40
      icon.append(mark)
    } else {
      icon.textContent = (pluginDisplayName(plugin).trim()[0] ?? '?').toUpperCase()
    }
    header.append(icon)

    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'toggle-switch plugin-toggle'
    toggleLabel.title = plugin.enabled ? 'Turn off this plugin' : 'Turn on this plugin'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = plugin.enabled
    toggle.className = 'plugin-toggle-input'
    toggle.setAttribute('aria-label', `${plugin.name} plugin enabled`)
    const track = document.createElement('span')
    track.className = 'toggle-switch-track'
    track.setAttribute('aria-hidden', 'true')
    // Set by a credential-gated plugin (below) once it knows no key is stored, so
    // the change handler's `finally` re-arms the lock instead of clearing it.
    let credentialLocked = false
    toggle.addEventListener('change', () => {
      toggle.disabled = true
      void api.plugins
        .setEnabled(plugin.id, toggle.checked)
        .then(async () => {
          await refreshPlugins()
          // Turning a plugin off is exactly what moves its declared MCP servers
          // between "off because the plugin is" and "off because we don't start
          // them yet", so the MCP lens has to follow the toggle rather than wait
          // for the next dialog open.
          void refreshDeclaredMcpServers()
          // Wake listeners that gate chrome on plugin enablement (e.g. the
          // Memories / Roadmap titlebar buttons in panel-mode-controls, which
          // read the plugin list) so a toggle takes effect without an app restart —
          // mirrors the `settings_changed` emit the Save button fires. Tool-only
          // plugins still emit for consistency with chrome-gating plugins.
          store.emit('settings_changed')
        })
        .catch(() => {
          toggle.checked = !toggle.checked
        })
        .finally(() => {
          toggle.disabled = credentialLocked && !toggle.checked
        })
    })
    toggleLabel.append(toggle, track)

    // Who published the plugin is the first thing to know about it and the same
    // answer for every row, so it reads as an eyebrow over the name rather than
    // as one more chip competing with it.
    const title = document.createElement('div')
    title.className = 'plugin-row-title'
    const trustBadge = document.createElement('span')
    trustBadge.className =
      plugin.trust === 'first-party'
        ? 'plugin-badge plugin-badge-first-party'
        : 'plugin-badge plugin-badge-user'
    trustBadge.textContent = plugin.trust === 'first-party' ? 'Copse' : 'User'
    title.append(trustBadge)

    const nameLine = document.createElement('div')
    nameLine.className = 'plugin-row-name-line'
    const nameEl = document.createElement('span')
    nameEl.className = 'plugin-name'
    nameEl.textContent = pluginDisplayName(plugin)
    nameLine.append(nameEl)
    if (plugin.version) {
      const versionEl = document.createElement('span')
      versionEl.className = 'plugin-version'
      versionEl.textContent = plugin.version
      nameLine.append(versionEl)
    }
    const stabilityBadge = document.createElement('span')
    stabilityBadge.className = `plugin-badge plugin-badge-${plugin.stability}`
    stabilityBadge.textContent = plugin.stability
    stabilityBadge.title =
      plugin.stability === 'experimental'
        ? 'Experimental: behavior and compatibility may change.'
        : 'Stable: supported as part of the current plugin contract.'
    nameLine.append(stabilityBadge)
    title.append(nameLine)

    // A bare switch never says which way is on. The flanking words do, and CSS
    // emphasises whichever side is live off `:checked` — so there is no second
    // copy of the state to keep in sync. They restate the checkbox's own label,
    // hence hidden from assistive tech.
    const toggleControl = document.createElement('div')
    toggleControl.className = 'plugin-toggle-control'
    const makeStateLabel = (side: 'off' | 'on'): HTMLElement => {
      const stateEl = document.createElement('span')
      stateEl.className = 'plugin-toggle-state'
      stateEl.dataset['side'] = side
      stateEl.textContent = side === 'on' ? 'On' : 'Off'
      stateEl.setAttribute('aria-hidden', 'true')
      return stateEl
    }
    toggleControl.append(makeStateLabel('off'), toggleLabel, makeStateLabel('on'))

    header.append(title, toggleControl)
    row.append(header)

    if (plugin.description) {
      const desc = document.createElement('div')
      desc.className = 'plugin-row-desc'
      desc.innerHTML = renderMarkdown(plugin.description)
      row.append(desc)
    }

    if (plugin.source?.kind === 'directory') {
      const review = document.createElement('div')
      review.className = 'plugin-source-review'

      const status = document.createElement('div')
      status.className = 'plugin-source-status'
      status.textContent = 'Selected directory · executable behaviors run in isolation'
      review.append(status)

      const details: Array<[string, string]> = [
        ['Source', plugin.source.path],
        ['Content', plugin.source.contentHash],
      ]
      const detailList = document.createElement('dl')
      detailList.className = 'plugin-source-details'
      for (const [term, value] of details) {
        const dt = document.createElement('dt')
        dt.textContent = term
        const dd = document.createElement('dd')
        dd.textContent = value
        detailList.append(dt, dd)
      }
      review.append(detailList)
      row.append(review)
    }

    // Contribution enumeration — the "about:addons" surface: users see exactly
    // what flipping the toggle takes out of new work.
    const contributions = plugin.contributions
    const chips: { label: string; count: number; title?: string }[] = []
    if (contributions.toolNames.length > 0) {
      chips.push({
        label: 'Tools',
        count: contributions.toolNames.length,
        title: contributions.toolNames.join(', '),
      })
    }
    if (contributions.modelRoutes.length > 0) {
      chips.push({
        label: 'Models',
        count: contributions.modelRoutes.length,
        title: contributions.modelRoutes.map((route) => `${route.label} (${route.id})`).join(', '),
      })
    }
    if (contributions.browserOrigins.length > 0) {
      chips.push({
        label: 'Browser origins',
        count: contributions.browserOrigins.length,
        title: contributions.browserOrigins.join(', '),
      })
    }
    if (contributions.mcpServersPath) {
      chips.push({ label: 'MCP config', count: 1, title: contributions.mcpServersPath })
    }
    const hookCount = contributions.blockingHooks.length + contributions.asyncHooks.length
    if (hookCount > 0) {
      const eventList = [
        ...contributions.blockingHooks.map((h) => `${h.id} (${h.event})`),
        ...contributions.asyncHooks.map((h) => `${h.id} (${h.event}, async)`),
      ]
      chips.push({ label: 'Hooks', count: hookCount, title: eventList.join(', ') })
    }
    if (contributions.commandHooks.length > 0) {
      chips.push({
        label: 'Command hooks',
        count: contributions.commandHooks.length,
        title: contributions.commandHooks.map((h) => `${h.event}: ${h.command}`).join(', '),
      })
    }
    if (contributions.promptBlocks.length > 0) {
      chips.push({
        label: 'Prompt blocks',
        count: contributions.promptBlocks.length,
        title: contributions.promptBlocks.map((b) => `${b.id} (${b.trust})`).join(', '),
      })
    }
    if (contributions.ui.length > 0) {
      chips.push({
        label: 'UI',
        count: contributions.ui.length,
        title: contributions.ui
          .map(
            (u) =>
              `L${String(u.level)} ${u.title ?? u.id}${u.panelKind ? ` (${u.panelKind})` : ''}`,
          )
          .join(', '),
      })
    }
    if (contributions.capabilities.length > 0) {
      chips.push({
        label: 'Capabilities',
        count: contributions.capabilities.length,
        title: contributions.capabilities.map((c) => `${c.title} (${c.name})`).join(', '),
      })
    }
    if (contributions.permissions.length > 0) {
      chips.push({
        label: 'Permissions',
        count: contributions.permissions.length,
        title: contributions.permissions
          .map((p) => `${p.title} (${p.name}${p.scope ? `, ${p.scope}` : ''})`)
          .join(', '),
      })
    }
    if (chips.length > 0) {
      const chipRow = document.createElement('div')
      chipRow.className = 'plugin-chips'
      for (const chip of chips) {
        const el = document.createElement('span')
        el.className = 'plugin-chip'
        el.textContent = `${chip.label} × ${String(chip.count)}`
        if (chip.title) el.title = chip.title
        chipRow.append(el)
      }
      row.append(chipRow)
    } else {
      const emptyChips = document.createElement('div')
      emptyChips.className = 'plugin-chips-empty'
      emptyChips.textContent = 'Contributes nothing yet (skeleton plugin).'
      row.append(emptyChips)
    }

    // Everything configurable about a plugin folds into one disclosure. The card
    // leads with what the plugin *is* and what it contributes — the decision you
    // make from a list of plugins — and keeps its knobs one click away rather than
    // stacking every plugin's form on top of the next plugin's name. Appended to the
    // row at the end, and only if something landed inside it.
    const settingsFold = document.createElement('details')
    settingsFold.className = 'plugin-settings-fold'
    const settingsSummary = document.createElement('summary')
    settingsSummary.className = 'plugin-settings-summary'
    const settingsSummaryLabel = document.createElement('span')
    settingsSummaryLabel.textContent = 'Plugin settings'
    // `ui-icon` is what carries `fill: none; stroke: currentColor` — an SVG path
    // without it takes the SVG default (filled, unstroked), so this chevron was
    // rendering as a solid triangle rather than the outline stroke every other
    // disclosure in the app uses. The class is replaced, not appended, by
    // outlineIcon, so it has to be named here.
    settingsSummary.append(settingsSummaryLabel, chevronDownIcon('ui-icon plugin-settings-chevron'))
    settingsFold.append(settingsSummary)

    // Generic plugin-scoped settings fields (rendered from the manifest schema).
    if (plugin.settings.length > 0) {
      const settingsBox = document.createElement('div')
      settingsBox.className = 'plugin-settings'
      for (const field of plugin.settings) {
        settingsBox.append(makePluginSettingField(plugin.id, field))
      }
      settingsFold.append(settingsBox)
      // The advisor model field owns the live executor/advisor pairing hint (it
      // moved here from the Experimental section with the model itself). Wire the
      // advisor select + a hint element into the shared refs, keep the `#advisorModel`
      // / `#advisorPairHint` ids other code (and the e2e) locate them by, and
      // re-grade on any change to the advisor model.
      if (plugin.id === ADVISOR_STRATEGY_PLUGIN_ID) {
        const advisorSelect = settingsBox.querySelector<HTMLSelectElement>(
          `.plugin-setting-model[data-setting-key="${ADVISOR_MODEL_SETTING_ID}"]`,
        )
        if (advisorSelect) {
          advisorSelect.id = 'advisorModel'
          const hint = document.createElement('p')
          hint.className = 'field-hint advisor-pair-hint'
          hint.id = 'advisorPairHint'
          hint.hidden = true
          settingsBox.append(hint)
          advisorModelSelectEl = advisorSelect
          advisorPairHintEl = hint
          advisorSelect.addEventListener('change', () => {
            updateAdvisorPairHint()
          })
          // Grade now (covers an already-loaded value), and again once this
          // picker's async catalogue refresh settles. Pairs with the executor-side
          // re-grade in `settings-open`; whichever finishes last reveals the hint.
          updateAdvisorPairHint()
          const populated = modelFieldPopulated.get(advisorSelect)
          if (populated) {
            void populated.then(() => {
              updateAdvisorPairHint()
            })
          }
        }
      }
    }

    // First-party level-3 settings detail. The manifest advertises the named
    // slot in the contribution chips; shipped renderer code supplies the view
    // (user plugins cannot inject arbitrary renderer code, decision 15).
    if (
      plugin.id === AUTOMATIONS_PLUGIN_ID &&
      plugin.contributions.ui.some(
        (contribution) =>
          contribution.level === 3 && contribution.slot === 'settings-plugin-detail',
      )
    ) {
      settingsFold.append(createAutomationPluginSettings(store, api, plugin.enabled))
    }
    if (
      plugin.id === PARALLEL_SEARCH_PLUGIN_ID &&
      plugin.contributions.ui.some(
        (contribution) =>
          contribution.level === 3 && contribution.slot === 'settings-plugin-detail',
      )
    ) {
      // Parallel Search is credential-gated end to end: `syncParallelSearchTools`
      // registers `parallel_search` only when the plugin is on AND a key resolves.
      // Without this the switch flips on with no key and nothing happens — an
      // on-looking plugin contributing no tool. Block the on-direction until a key
      // is stored (never the off-direction, or a user who clears their key would
      // be stuck with the plugin showing enabled), and say why in a hint.
      // The gate explains a switch you can see is locked, so it stays on the
      // face of the card — folding the reason away under "Plugin settings" would
      // leave a dead toggle with no explanation next to it.
      const gate = document.createElement('p')
      gate.className = 'field-hint plugin-credential-gate'
      gate.hidden = true
      row.append(gate)
      settingsFold.append(
        createParallelSearchPluginSettings(api, {
          onKeyPresence: (hasKey) => {
            credentialLocked = !hasKey
            toggle.disabled = credentialLocked && !toggle.checked
            gate.hidden = hasKey
            gate.textContent = toggle.checked
              ? 'No Parallel API key saved — parallel_search stays unavailable to the model until you add one.'
              : 'Add a Parallel API key to turn this plugin on.'
            if (toggle.disabled) toggleLabel.title = 'Add a Parallel API key to turn this plugin on'
          },
        }),
      )
    }

    // A plugin with nothing to configure shows no fold — an empty disclosure is
    // worse than none, because it invites a click that reveals nothing.
    if (settingsFold.childElementCount > 1) row.append(settingsFold)

    // Disabling greys the whole row so the effect of the toggle is immediately
    // visible; individual plugin-scoped settings stay editable so users can
    // configure a disabled plugin before re-enabling it.
    if (!plugin.enabled) row.classList.add('plugin-row-disabled')

    return row
  }

  function makePluginSettingField(
    pluginId: string,
    field: import('@shared/types/plugins.ts').PluginSettingFieldSummary,
  ): HTMLElement {
    const label = document.createElement('label')
    label.className = 'plugin-setting-field'
    const title = document.createElement('span')
    title.className = 'plugin-setting-title'
    title.textContent = field.title
    label.append(title)

    let input: HTMLInputElement | HTMLSelectElement
    let modelFieldCurrent: string | undefined
    let modelSelectInput: HTMLSelectElement | null = null
    if (field.kind === 'boolean') {
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = field.value === true
      checkbox.className = 'plugin-setting-input plugin-setting-boolean'
      input = checkbox
    } else if (field.kind === 'enum') {
      const select = document.createElement('select')
      select.className = 'plugin-setting-input plugin-setting-enum'
      for (const option of field.options ?? []) {
        const opt = document.createElement('option')
        opt.value = option
        opt.textContent = option
        if (option === field.value) opt.selected = true
        select.append(opt)
      }
      input = select
    } else if (field.kind === 'number') {
      const number = document.createElement('input')
      number.type = 'number'
      number.value = String(field.value)
      number.className = 'plugin-setting-input plugin-setting-number'
      input = number
    } else if (field.kind === 'model') {
      // Model settings use the same searchable, provider-grouped picker as the
      // composer. The manifest stores only the current id; options stay live.
      const select = document.createElement('select')
      select.className = 'plugin-setting-input plugin-setting-model'
      modelFieldCurrent = typeof field.value === 'string' ? field.value : ''
      modelSelectInput = select
      input = select
    } else {
      const text = document.createElement('input')
      text.type = 'text'
      text.value = typeof field.value === 'string' ? field.value : String(field.value)
      text.className = 'plugin-setting-input plugin-setting-string'
      input = text
    }
    input.dataset['pluginId'] = pluginId
    input.dataset['settingKey'] = field.id

    // Persist on change so the manifest schema is the source of truth — no
    // Save-button plumbing needed, mirroring the MCP per-server toggle.
    input.addEventListener('change', () => {
      let value: unknown = input.value
      if (field.kind === 'boolean') {
        if (!(input instanceof HTMLInputElement)) {
          throw new Error('Boolean plugin setting must render as an input')
        }
        value = input.checked
      } else if (field.kind === 'number') {
        value = Number(input.value)
      }
      void api.plugins.setSetting(pluginId, field.id, value).catch(() => {
        // Best-effort: on failure the on-screen value stays; next reload
        // resyncs to storage.
      })
    })

    label.append(input)
    if (modelSelectInput) {
      // A plugin's model field selects a *rule*, not a model: plugins run
      // unattended long after this dialog was last open, so the picker offers
      // dynamic selections only (see `dynamicModelOptions`). A field the
      // manifest gave no default has a meaningful blank state — the owning
      // feature's own fallback — so that stays selectable.
      const autoLabel =
        field.default === undefined ? '(unset — use this feature’s own fallback)' : undefined
      const picker = mountModelSelectPicker(modelSelectInput, {
        loadOptions: (current) => fetchDynamicModelOptions(current, autoLabel),
        ariaLabel: field.title,
        loadOnMount: false,
      })
      modelFieldPopulated.set(modelSelectInput, picker.refresh(modelFieldCurrent ?? ''))
    }
    if (field.description) {
      const hint = document.createElement('span')
      hint.className = 'plugin-setting-desc'
      hint.textContent = field.description
      label.append(hint)
    }
    if (modelSelectInput) label.append(mountResolvedModelHint(modelSelectInput))
    return label
  }

  /**
   * Live "→ currently <model>" line under a dynamic model picker. The rule is
   * what gets stored, but the user still deserves to see which model it names
   * today — that is the one thing a selector hides that a pinned id showed.
   */
  function mountResolvedModelHint(select: HTMLSelectElement): HTMLElement {
    const hint = document.createElement('span')
    hint.className = 'plugin-setting-resolved'
    hint.hidden = true
    let generation = 0
    const update = (): void => {
      const value = select.value
      const mine = ++generation
      if (!value) {
        hint.hidden = true
        return
      }
      void api.models
        .resolveDynamic(value)
        .then((resolved) => {
          // Ignore a slow answer for a selection the user has already changed.
          if (mine !== generation) return
          hint.hidden = !resolved || resolved === value
          hint.textContent = `Currently resolves to ${modelDisplayLabel(resolved)}`
        })
        .catch(() => {
          if (mine === generation) hint.hidden = true
        })
    }
    select.addEventListener('change', update)
    update()
    return hint
  }

  async function refreshPlugins(): Promise<void> {
    const listEl = qsRequired(overlay, '#plugins-list')
    const statusEl = qsRequired(overlay, '#plugins-reload-status')
    statusEl.textContent = 'Loading…'
    try {
      // Two origins, one list. The registry owns lifecycle for everything Copse
      // installed; Cursor owns its own cache, so those rows are read-only. A
      // Cursor failure must not blank the registry rows beside it, hence the
      // catch rather than a bare Promise.all.
      const [result, cursorPlugins] = await Promise.all([
        api.plugins.list(),
        api.cursorPlugins.list().catch(() => []),
      ])
      listEl.innerHTML = ''
      if (result.plugins.length === 0 && cursorPlugins.length === 0) {
        const empty = document.createElement('span')
        empty.className = 'plugins-empty'
        empty.textContent = 'No plugins installed.'
        listEl.append(empty)
      } else {
        // Enabled plugins first, disabled plugins after — so a scrapped plugin moves
        // out of the way instead of sitting in the middle of the list. The two
        // runs get a heading each: with rows this tall, "why is this one dimmed"
        // is a question the list should answer before it is asked. A heading is
        // skipped when nothing falls under it.
        // One sequence, whatever installed the plugin. A Cursor plugin sorts in
        // as `enabled: true` because it genuinely is — nothing gates
        // `~/.cursor/plugins`, so it is contributing exactly like the rows
        // around it, and the reader's question is "is this on", not "who
        // packaged it". Origin is a badge on the row, not a section.
        const entries: { id: string; enabled: boolean; render: () => HTMLElement }[] = [
          ...result.plugins.map((plugin) => ({
            id: plugin.id,
            enabled: plugin.enabled,
            render: () => makePluginRow(plugin),
          })),
          ...cursorPlugins.map((plugin) => ({
            id: plugin.name,
            enabled: true,
            render: () => makeCursorPluginRow(plugin),
          })),
        ].sort((a, b) => Number(!a.enabled) - Number(!b.enabled) || a.id.localeCompare(b.id))

        let lastEnabled: boolean | null = null
        for (const entry of entries) {
          if (entry.enabled !== lastEnabled) {
            const heading = document.createElement('h4')
            heading.className = 'plugins-group-heading'
            heading.textContent = entry.enabled ? 'Active' : 'Inactive'
            listEl.append(heading)
            lastEnabled = entry.enabled
          }
          listEl.append(entry.render())
        }
      }
      statusEl.textContent = ''
    } catch {
      statusEl.textContent = 'Failed to load plugins.'
    }
  }

  /**
   * A Cursor-installed plugin, rendered as an ordinary plugin row.
   *
   * It gets the same shape as every other row — icon, origin badge, name,
   * switch, contributions — because a user asking "what is extending Copse"
   * should not have to learn that one answer lives in a differently-shaped card
   * at the bottom of the list.
   *
   * **It reports Active, and that is a claim worth being sure of.** Nothing
   * gates `~/.cursor/plugins`: `skills-registry.ts` adds every discovered
   * plugin's skills directory unconditionally, and `mcp-registry.ts` reads
   * every discovered plugin's MCP config the same way. So an installed Cursor
   * plugin is always contributing, and the row says so.
   *
   * The switch is therefore shown **on and disabled**. Cursor owns the
   * lifecycle, so this is the honest rendering: the state is real, and the
   * control is visibly not ours to move. Omitting the switch entirely was worse
   * — it left the one question the list exists to answer unanswered.
   */
  function makeCursorPluginRow(
    plugin: import('@shared/types/cursor-plugins.ts').CursorPluginSummary,
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'plugin-row'
    row.dataset['pluginId'] = plugin.name
    row.dataset['pluginOrigin'] = 'cursor'
    row.dataset['enabled'] = 'true'

    const header = document.createElement('div')
    header.className = 'plugin-row-header'

    // Cursor's own cube mark, the real asset — the same reasoning that gives a
    // first-party row the Copse glyph and a sideloaded one a neutral initial:
    // a mark stands for who made the thing, so it is theirs to draw, not ours.
    // It keeps the neutral tile rather than the Copse mark's neon field, which
    // would read as our endorsement of someone else's plugin.
    const icon = document.createElement('span')
    icon.className = 'plugin-icon plugin-icon-cursor'
    icon.setAttribute('aria-hidden', 'true')
    const mark = document.createElement('img')
    mark.src = './cursor-mark.svg'
    mark.alt = ''
    icon.append(mark)
    header.append(icon)

    const title = document.createElement('div')
    title.className = 'plugin-row-title'
    const originBadge = document.createElement('span')
    originBadge.className = 'plugin-badge plugin-badge-cursor'
    originBadge.textContent = 'Cursor'
    originBadge.title = 'Installed through Cursor — Copse loads it, Cursor manages it.'
    title.append(originBadge)

    const nameLine = document.createElement('div')
    nameLine.className = 'plugin-row-name-line'
    const nameEl = document.createElement('span')
    nameEl.className = 'plugin-name'
    nameEl.textContent = plugin.name
    nameLine.append(nameEl)
    if (plugin.version) {
      const versionEl = document.createElement('span')
      versionEl.className = 'plugin-version'
      versionEl.textContent = plugin.version
      nameLine.append(versionEl)
    }
    title.append(nameLine)

    const toggleControl = document.createElement('div')
    toggleControl.className = 'plugin-toggle-control'
    const makeStateLabel = (side: 'off' | 'on'): HTMLElement => {
      const stateEl = document.createElement('span')
      stateEl.className = 'plugin-toggle-state'
      stateEl.dataset['side'] = side
      stateEl.textContent = side === 'on' ? 'On' : 'Off'
      stateEl.setAttribute('aria-hidden', 'true')
      return stateEl
    }
    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'toggle-switch plugin-toggle'
    toggleLabel.title = 'Managed by Cursor — turn it off in Cursor, not here.'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = true
    toggle.disabled = true
    toggle.className = 'plugin-toggle-input'
    toggle.setAttribute('aria-label', `${plugin.name} plugin enabled (managed by Cursor)`)
    const track = document.createElement('span')
    track.className = 'toggle-switch-track'
    track.setAttribute('aria-hidden', 'true')
    toggleLabel.append(toggle, track)
    toggleControl.append(makeStateLabel('off'), toggleLabel, makeStateLabel('on'))

    header.append(title, toggleControl)
    row.append(header)

    if (plugin.description) {
      const desc = document.createElement('div')
      desc.className = 'plugin-row-desc'
      desc.textContent = plugin.description
      row.append(desc)
    }

    const chips = document.createElement('div')
    chips.className = 'plugin-chips'
    const contributes: string[] = []
    if (plugin.skillsDir) contributes.push('Skills')
    if (plugin.mcpConfigPath) contributes.push('MCP servers')
    if (contributes.length === 0) {
      const none = document.createElement('span')
      none.className = 'plugin-chips-empty'
      none.textContent = 'Contributes nothing Copse can load'
      chips.append(none)
    } else {
      for (const label of contributes) {
        const chip = document.createElement('span')
        chip.className = 'plugin-chip'
        chip.textContent = label
        chips.append(chip)
      }
    }
    row.append(chips)

    const path = document.createElement('p')
    path.className = 'plugin-source-path'
    path.textContent = plugin.root
    row.append(path)

    return row
  }

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
    chip.className = `mcp-origin-chip mcp-origin-${s.origin}`
    chip.dataset['mcpOrigin'] = s.origin
    chip.textContent = s.originDetail && s.origin === 'plugin' ? s.originDetail : labels[s.origin]
    chip.title = s.originDetail ? `${labels[s.origin]} — ${s.originDetail}` : labels[s.origin]
    return chip
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
            `⚠ This workspace declares ${String(unsandboxed.length)} ${plural} with ` +
            `"sandbox": false in .copse/hooks.json. Trusting this workspace allows ` +
            `${unsandboxed.length === 1 ? 'it' : 'them'} to run OUTSIDE the project sandbox:`
          const list = document.createElement('ul')
          for (const h of unsandboxed) {
            const li = document.createElement('li')
            li.textContent = `${h.event}: ${h.command}`
            list.append(li)
          }
          warn.append(label, list)
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
      title.append(`${s.name} (${s.transport}): `, badge)

      header.append(toggleLabel, title, mcpOriginChip(s))
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
      title.append(`${s.name} (${s.transport}): `, inlineStatus('idle', 'not running'))

      const chip = document.createElement('span')
      chip.className = 'mcp-origin-chip mcp-origin-plugin'
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
    try {
      renderDeclaredMcpServers(await api.mcp.listDeclared())
    } catch {
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
        setInlineStatus(statusEl, 'error', errorMessage(err))
        statusEl.classList.add('err')
      })
  })

  qsRequired(overlay, '#sources-reload-btn').addEventListener('click', () => {
    void refreshSources()
  })

  qsRequired(overlay, '#plugins-reload-btn').addEventListener('click', () => {
    void refreshPlugins()
  })

  qsRequired(overlay, '#plugins-add-btn').addEventListener('click', () => {
    const button = qsRequired<HTMLButtonElement>(overlay, '#plugins-add-btn')
    const status = qsRequired(overlay, '#plugins-reload-status')
    button.disabled = true
    status.textContent = 'Choose a folder containing copse-plugin.json…'
    void api.plugins
      .addSource()
      .then(() => refreshPlugins())
      .catch((error: unknown) => {
        status.textContent = errorMessage(error)
      })
      .finally(() => {
        button.disabled = false
      })
  })

  // Live advisor-pair assessment (docs/plans/advisor-strategy.md): grade the
  // (executor, advisor) pairing from the model capability annotations — cloud
  // tiers and the local catalog — whenever either picker changes, so the user
  // learns up front whether the advisor is actually stronger than the executor.
  // Either side may be a dynamic selection, so both are resolved first — this
  // counter drops a slow answer for a pairing the user has already changed.
  let advisorPairGeneration = 0

  function updateAdvisorPairHint(): void {
    const hint = advisorPairHintEl
    const advisorSelect = advisorModelSelectEl
    if (!hint || !advisorSelect) return
    const form = qsRequired<HTMLFormElement>(overlay, 'form')
    const executor = selectControl(form, 'model').value
    const advisor = advisorSelect.value
    const mine = ++advisorPairGeneration
    if (!executor || !advisor) {
      hint.hidden = true
      return
    }
    // Both sides may be rules rather than model ids. Grade the models they name
    // right now — a hint about `auto:best-intellect` would say nothing useful,
    // and the whole point of the pairing hint is a concrete capability
    // comparison. `resolveDynamic` returns a pinned id unchanged.
    void Promise.all([api.models.resolveDynamic(executor), api.models.resolveDynamic(advisor)])
      .then(([resolvedExecutor, resolvedAdvisor]) => {
        if (mine !== advisorPairGeneration) return
        const assessment = validateAdvisorPair(resolvedExecutor, resolvedAdvisor)
        const dynamic = resolvedAdvisor !== advisor || resolvedExecutor !== executor
        hint.textContent = dynamic
          ? `${assessment.reason} (currently ${modelDisplayLabel(resolvedExecutor)} → ${modelDisplayLabel(resolvedAdvisor)})`
          : assessment.reason
        hint.setAttribute('data-level', assessment.level)
        hint.hidden = false
      })
      .catch(() => {
        if (mine !== advisorPairGeneration) return
        // Resolution unavailable: grade what is stored. A selector lands on the
        // dynamic branch of `validateAdvisorPair`, which says exactly that.
        const assessment = validateAdvisorPair(executor, advisor)
        hint.textContent = assessment.reason
        hint.setAttribute('data-level', assessment.level)
        hint.hidden = false
      })
  }

  overlay.addEventListener('settings-open', () => {
    appearanceBaseline = currentAppearance()
    appearanceCommitted = false
    resetDirtyState()
    developerModeInput.checked = store.getState().developerMode
    syncDeveloperOnlySettings()
    // A fresh open always starts on a section, never in a leftover search.
    searchContentLoaded = false
    if (searchInput.value) {
      searchInput.value = ''
    }
    applySearch('')
    const openedSection = pendingSection ?? 'general'
    showSection(openedSection)
    pendingSection = null
    // Deep-links (e.g. status banner → SSH) skip the nav click path, so refresh
    // lazy section content here too.
    if (openedSection === 'ssh') void sshWorkspaceSection.refresh()
    if (openedSection === 'usage') void usageSection.refresh()
    if (openedSection === 'customise') {
      void refreshSources()
      void refreshPlugins()
    }
    if (openedSection === 'storage') void refreshWorktrees()
    searchInput.focus()
    void (async (): Promise<void> => {
      // These stages used to be one unbroken `await` chain inside this
      // `void (async …)()`. A rejection anywhere aborted every later step, and
      // `void` left the rejection nowhere to surface — so a single failed IPC
      // emptied the rest of the dialog with no error anywhere. That is how
      // `.gh-cli-status` (second-to-last step) reached CI blank: `refreshStatus`
      // writes "Checking GitHub CLI…" synchronously before its first `await`, so
      // an empty status means it was never called, not that `gh.status()` failed.
      failedRefreshStages.length = 0
      delete overlay.dataset['settingsRefreshFailed']

      await refreshStage('key-statuses', async () => {
        await cursorKeySection.refreshKeyStatus()
        await claudeAgentKeySection.refreshKeyStatus()
        await aaKeySection.refreshKeyStatus()
      })
      await refreshStage('provider-sections', async () => {
        await envKeyDetectSection.refresh()
        await providersPanel.refresh()
      })

      const form = qsRequired<HTMLFormElement>(overlay, 'form')
      await refreshStage('model-pickers', async () => {
        const model = storedString(await api.settings.get('model'))
        await settingsModelPickers.model.refresh(model ?? DEFAULT_APP_CHAT_MODEL)
        // Parameters are per model, so the section renders against whichever
        // chat model just settled.
        await modelParametersSection.refresh(model ?? DEFAULT_APP_CHAT_MODEL)
        // The executor (chat) model just settled — re-grade the advisor pairing
        // hint, which lives with the advisor plugin in the Plugins section. No-op until
        // that plugin row has rendered (its select/hint refs are still null); pairs
        // with the `updateAdvisorPairHint()` call in `refreshPlugins()` so whichever
        // of the two async renders finishes last shows the hint.
        updateAdvisorPairHint()
        const smallTasksModel = storedString(await api.settings.get('smallTasksModel'))
        const roleModels = stringRecordOrEmpty(await api.settings.get('roleModels'))
        await settingsModelPickers.smallTasksModel.refresh(
          roleModels['small-tasks'] ?? smallTasksModel ?? '',
        )
        // The advisor model and the three comparison models are no longer form
        // fields: they are plugin-scoped `model` settings rendered in Settings →
        // Plugins (advisor pair hint included), populated by `refreshPlugins()`.
        const orchestrationWorkerModel = storedString(
          await api.settings.get('orchestrationWorkerModel'),
        )
        await settingsModelPickers.orchestrationWorkerModel.refresh(
          orchestrationWorkerModel ?? DEFAULT_ORCHESTRATION_WORKER_MODEL,
        )
      })

      await refreshStage('form-fields', async () => {
        await loadSimpleFields(form, api)
        syncDeveloperOnlySettings()
        wireSafetySliders(form)
        const savedWebOrigins = storedStringArray(
          await api.settings.get(WEB_ALLOWED_ORIGINS_SETTING),
        )
        textareaControl(form, 'webAllowedOrigins').value = (
          savedWebOrigins?.length ? savedWebOrigins : DEFAULT_WEB_ALLOWED_ORIGINS
        ).join('\n')
        const savedProviderHosts = storedStringArray(
          await api.settings.get(APPROVED_PROVIDER_HOSTS_SETTING),
        )
        textareaControl(form, 'approvedProviderHosts').value = (
          Array.isArray(savedProviderHosts) ? savedProviderHosts : []
        ).join('\n')
        textareaControl(form, 'trustedShellCommands').value = formatTrustedCommands(
          sanitizeTrustedCommands(await api.settings.get(TRUSTED_COMMANDS_SETTING)),
        )
        selectControl(form, 'shellAutoApprovalLevel').value = sanitizeAutoApprovalLevel(
          await api.settings.get(AUTO_APPROVAL_LEVEL_SETTING),
        )
        selectControl(form, 'theme').value = store.getState().themePreference
        inputControl(form, 'fontSize').value = String(store.getState().fontSize)
        const uiScaleInput = form.elements.namedItem('uiScale')
        if (!(uiScaleInput instanceof HTMLInputElement)) {
          throw new Error('Settings dialog template is missing "uiScale"')
        }
        uiScaleInput.value = String(store.getState().uiScale)
        inputControl(form, 'autoPortraitRightPanel').checked =
          store.getState().autoPortraitRightPanel
        selectControl(form, 'rightPanelPosition').value = store.getState().rightPanelPosition
      })

      await refreshStage('appearance', async () => {
        const savedAccentColor = await api.settings.get('uiAccentColor')
        inputControl(form, 'uiAccentColor').value =
          typeof savedAccentColor === 'string' && HEX_COLOR.test(savedAccentColor)
            ? savedAccentColor
            : DEFAULT_ACCENT_COLOR

        const savedTintColor = await api.settings.get('uiTintColor')
        inputControl(form, 'uiTintColor').value =
          typeof savedTintColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(savedTintColor)
            ? savedTintColor
            : DEFAULT_TINT_COLOR
        const rawTintStrength = await api.settings.get('uiTintStrength')
        const savedTintStrength = isUiTintStrength(rawTintStrength)
          ? rawTintStrength
          : DEFAULT_TINT_STRENGTH
        const strengthInput = form.querySelector<HTMLInputElement>('input[name="uiTintStrength"]')
        if (strengthInput) {
          strengthInput.value = String(tintSliderIndex(savedTintStrength))
          const strengthOutput = form.querySelector<HTMLOutputElement>(
            'output[for="uiTintStrength"]',
          )
          if (strengthOutput) strengthOutput.textContent = TINT_STRENGTH_LABELS[savedTintStrength]
        }

        const savedIconVariant = await api.settings.get('appIconVariant')
        const appIconVariant = isAppIconVariant(savedIconVariant)
          ? savedIconVariant
          : DEFAULT_APP_ICON_VARIANT
        const iconRadio = form.querySelector<HTMLInputElement>(
          `input[name="appIconVariant"][value="${appIconVariant}"]`,
        )
        if (iconRadio) iconRadio.checked = true
      })

      await refreshStage('local-models', () => refreshLocalModelSelects())
      await refreshStage('gh-cli', () => ghCliSection.refreshStatus())
      await refreshStage('mcp-servers', async () => {
        await refreshMcpServers()
        await refreshCuratedServers()
        await refreshDeclaredMcpServers()
      })
    })()
  })

  settingsForm.addEventListener('input', (e) => {
    markDirtyTarget(e.target)
  })
  settingsForm.addEventListener('change', (e) => {
    const target = e.target
    markDirtyTarget(target)
    if (target === developerModeInput || target === hooksEnabledInput) {
      syncDeveloperOnlySettings()
    }
    // Theme changes should apply instantly, not only after Save.
    if (target instanceof HTMLSelectElement && target.name === 'theme') {
      const preference = isThemePreference(target.value) ? target.value : DEFAULT_THEME_PREFERENCE
      const theme = resolveTheme(preference)
      document.documentElement.dataset['theme'] = theme
      store.emit('theme_changed', theme)
    }
    // Same for the Appearance accent/tint controls: reflect them live so the
    // user sees the effect before committing.
    if (target instanceof HTMLInputElement && target.type === 'color') {
      if (target.name === 'uiAccentColor' && HEX_COLOR.test(target.value)) {
        applyUiAccent(target.value)
      } else if (target.name === 'uiTintColor' && HEX_COLOR.test(target.value)) {
        const strengthInput = settingsForm.querySelector<HTMLInputElement>(
          'input[name="uiTintStrength"]',
        )
        const strength = tintStrengthFromValue(
          strengthInput ? Number(strengthInput.value) : DEFAULT_TINT_STRENGTH,
        )
        applyUiTint(target.value, strength)
      }
    }
    if (target instanceof HTMLInputElement && target.name === 'uiTintStrength') {
      const strength = tintStrengthFromValue(Number(target.value))
      const tintColor = settingsForm.querySelector<HTMLInputElement>('input[name="uiTintColor"]')
      const colorRaw = tintColor?.value
      const color =
        typeof colorRaw === 'string' && HEX_COLOR.test(colorRaw) ? colorRaw : DEFAULT_TINT_COLOR
      const strengthOutput = settingsForm.querySelector<HTMLOutputElement>(
        'output[for="uiTintStrength"]',
      )
      if (strengthOutput) strengthOutput.textContent = TINT_STRENGTH_LABELS[strength]
      applyUiTint(color, strength)
    }
    // The executor (chat) model changed — re-grade the advisor pairing hint,
    // which now lives with the advisor plugin's model field (Settings → Plugins).
    if (target instanceof HTMLSelectElement && target.name === 'model') {
      updateAdvisorPairHint()
      modelParametersSection.setModel(target.value)
    }
  })
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async (): Promise<void> => {
      const data = new FormData(settingsForm)

      if (cursorKeysDirty) await cursorKeySection.saveKeys()
      if (claudeAgentKeysDirty) await claudeAgentKeySection.saveKeys()
      if (aaKeysDirty) await aaKeySection.saveKeys()
      if (providersDirty) await providersPanel.saveKeys()
      await modelParametersSection.save()
      if (lmStudioDirty) await lmStudioSection.saveApiKey()
      const routingValues = modelRoutingSection.readValues()

      const model = formDataString(data, 'model')
      const themePrefRaw = data.get('theme')
      const themePreference = isThemePreference(themePrefRaw)
        ? themePrefRaw
        : DEFAULT_THEME_PREFERENCE
      // `theme` is the concrete value panes render; `system` resolves against the OS.
      const theme = resolveTheme(themePreference)
      const fontSize = parseInt(formDataString(data, 'fontSize'), 10)
      const uiScaleField = data.get('uiScale')
      const uiScaleRaw = typeof uiScaleField === 'string' ? parseFloat(uiScaleField) : Number.NaN
      const uiScale = Number.isFinite(uiScaleRaw)
        ? clampUiScale(uiScaleRaw)
        : normalizeUiScale(store.getState().uiScale)
      const autoPortraitRightPanel = data.get('autoPortraitRightPanel') === 'on'
      const rightPanelPositionRaw = data.get('rightPanelPosition')
      const rightPanelPosition = isRightPanelPosition(rightPanelPositionRaw)
        ? rightPanelPositionRaw
        : 'auto'
      const appIconVariant = data.get('appIconVariant')
      const externalDeny = parseFloat(formDataString(data, 'safetyExternalDenyThreshold'))
      const developerMode = data.get(DEVELOPER_MODE_SETTING) === 'on'

      const accentColorRaw = data.get('uiAccentColor')
      const uiAccentColor =
        typeof accentColorRaw === 'string' && HEX_COLOR.test(accentColorRaw)
          ? accentColorRaw
          : DEFAULT_ACCENT_COLOR
      const tintColorRaw = data.get('uiTintColor')
      const uiTintColor =
        typeof tintColorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(tintColorRaw)
          ? tintColorRaw
          : DEFAULT_TINT_COLOR
      const tintStrengthRaw = data.get('uiTintStrength')
      const uiTintStrength = tintStrengthFromValue(tintStrengthRaw)

      const writes: Promise<unknown>[] = [saveSimpleFields(data, api, dirtyFieldNames)]
      const saveIfDirty = (name: string, value: unknown): void => {
        if (dirtyFieldNames.has(name)) writes.push(api.settings.set(name, value))
      }

      saveIfDirty('model', model)
      saveIfDirty('smallTasksModel', formDataString(data, 'smallTasksModel').trim())
      // `advisorModel` and the three `comparisonModel*` values are no longer
      // saved here — they are plugin-scoped `model` settings persisted on change
      // via `plugins:setSetting` from Settings → Plugins.
      saveIfDirty(
        'orchestrationWorkerModel',
        formDataString(data, 'orchestrationWorkerModel').trim(),
      )
      saveIfDirty('theme', themePreference)
      saveIfDirty('fontSize', fontSize)
      saveIfDirty('uiScale', uiScale)
      saveIfDirty('autoPortraitRightPanel', autoPortraitRightPanel)
      saveIfDirty('rightPanelPosition', rightPanelPosition)
      saveIfDirty('uiAccentColor', uiAccentColor)
      saveIfDirty('uiTintColor', uiTintColor)
      saveIfDirty('uiTintStrength', uiTintStrength)
      saveIfDirty('localDefaultModel', routingValues.localDefaultModel)
      saveIfDirty('subagentModel', routingValues.subagentModel)

      if (dirtyFieldNames.has('appIconVariant') && isAppIconVariant(appIconVariant)) {
        writes.push(
          (async (): Promise<void> => {
            await api.settings.set('appIconVariant', appIconVariant)
            await api.appIcon.apply()
          })(),
        )
      }

      if (
        dirtyFieldNames.has('localDefaultModel') ||
        dirtyFieldNames.has('subagentModel') ||
        dirtyFieldNames.has('smallTasksModel')
      ) {
        writes.push(
          (async (): Promise<void> => {
            const savedRoleModels = stringRecordOrEmpty(await api.settings.get('roleModels'))
            await api.settings.set('roleModels', {
              ...savedRoleModels,
              coder: routingValues.localDefaultModel,
              research: routingValues.subagentModel,
              'small-tasks': formDataString(data, 'smallTasksModel').trim(),
            })
          })(),
        )
      }

      const securityFieldNames = [
        'localServerUrl',
        'safetyModel',
        'reviewModel',
        'safetyClassifierEnabled',
        'safetyExternalDenyThreshold',
        'autoRunSandboxCommands',
        'cursorHooksEnabled',
        'mcpAutoAllowReadOnly',
        'defaultReadonlyMode',
        'webAllowedOrigins',
        WEB_ALLOW_USER_APPROVAL_SETTING,
        'approvedProviderHosts',
        PROVIDER_ALLOW_USER_APPROVAL_SETTING,
        'trustedShellCommands',
        AUTO_APPROVAL_LEVEL_SETTING,
      ]
      if (securityFieldNames.some((name) => dirtyFieldNames.has(name))) {
        writes.push(
          api.settings.setSecurity({
            localServerUrl: lmStudioSection.getUrl(),
            safetyModel: routingValues.safetyModel,
            reviewModel: routingValues.reviewModel,
            safetyClassifierEnabled: data.get('safetyClassifierEnabled') === 'on',
            safetyExternalDenyThreshold: Number.isFinite(externalDeny) ? externalDeny : 1,
            autoRunSandboxCommands: data.get('autoRunSandboxCommands') === 'on',
            cursorHooksEnabled: data.get('cursorHooksEnabled') === 'on',
            mcpAutoAllowReadOnly: data.get('mcpAutoAllowReadOnly') === 'on',
            defaultReadonlyMode: data.get('defaultReadonlyMode') === 'on',
            webAllowedOrigins: parseWebAllowedOrigins(data.get('webAllowedOrigins')),
            webAllowUserApproval: data.get(WEB_ALLOW_USER_APPROVAL_SETTING) === 'on',
            approvedProviderHosts: parseApprovedProviderHosts(data.get('approvedProviderHosts')),
            providerAllowUserApproval: data.get(PROVIDER_ALLOW_USER_APPROVAL_SETTING) === 'on',
            trustedShellCommands: parseTrustedCommands(
              formDataString(data, 'trustedShellCommands'),
            ),
            shellAutoApprovalLevel: sanitizeAutoApprovalLevel(
              data.get(AUTO_APPROVAL_LEVEL_SETTING),
            ),
          }),
        )
      }

      await Promise.all(writes)

      store.setState({
        theme,
        themePreference,
        fontSize,
        uiScale,
        autoPortraitRightPanel,
        rightPanelPosition,
        openLinksInBuiltInBrowser: data.get('openLinksInBuiltInBrowser') === 'on',
        developerMode,
        settings: { ...store.getState().settings, model },
      })
      store.emit('theme_changed', theme)
      store.emit('settings_changed')
      window.dispatchEvent(new Event('copse:skills-changed'))
      document.documentElement.dataset['theme'] = theme
      applyUiAccent(uiAccentColor)
      applyUiTint(uiTintColor, uiTintStrength)
      applyUiScale(uiScale)
      appearanceCommitted = true
      closeSettingsDialog()
    })()
  })

  overlay.addEventListener('close', () => {
    if (!appearanceCommitted && appearanceBaseline) applyAppearancePreview(appearanceBaseline)
    appearanceBaseline = null
    resetDirtyState()
  })

  qsRequired(overlay, '#settings-cancel').addEventListener('click', closeSettingsDialog)
  qsRequired(overlay, '#settings-close').addEventListener('click', closeSettingsDialog)
}
