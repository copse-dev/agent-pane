import type { ApiClient } from '../../../preload/api.d.ts'
import type { AcpAgentConfig, AcpModeChoice, AcpModelChoice } from '@shared/types/acp.ts'
import { parseAcpAgentConfigs } from '@shared/acp.ts'
import {
  KNOWN_ACP_AGENTS,
  type DetectedAcpAgent,
  type KnownAcpAgent,
} from '@shared/acp-known-agents.ts'
import { el, clear } from '../../dom/helpers.ts'
import { inlineStatus, setInlineStatus } from '../../dom/inline-status.ts'
import type { ModelOption } from '../model-options.ts'
import { mountModelSelectPicker } from '../model-picker.ts'

// Settings panel for external ACP agents Copse drives as a client (the `acp:<id>`
// models). It scans the device (acp:detectAgents) and lists the known agents with
// their install + sign-in commands ("preinstall" guidance), one-click add, plus a
// CRUD editor over the `registeredAcpAgents` setting for configured/custom agents.
//
// The panel mirrors the unified "Providers" panel (custom-providers-section.ts):
// a chip row selects one agent and shows just its form, so each agent is hidden
// away until picked rather than every card being expanded at once. Known agents
// lead the row, followed by any custom-configured agents, then an "Add agent"
// chip. A dot marks the agents you've added.
//
// Pure helpers (parse/format/upsert/knownToConfig) are exported and unit-tested;
// the rest is thin DOM glue that persists on every change via settings.set.

export interface AcpAgentsSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** `KEY=value` lines → an env record. Blank lines and lines without `=` are skipped. */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

export function formatEnvText(env?: Record<string, string>): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** One argument per line. */
export function parseArgsText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function formatArgsText(args?: string[]): string {
  return (args ?? []).join('\n')
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Replace the agent with the same id, or append it. */
export function upsertAgent(list: AcpAgentConfig[], agent: AcpAgentConfig): AcpAgentConfig[] {
  const idx = list.findIndex((a) => a.id === agent.id)
  if (idx === -1) return [...list, agent]
  const next = [...list]
  next[idx] = agent
  return next
}

/** Keep cached selector choices when a partial ACP probe omits that selector. */
export function selectorChoicesAfterProbe<T>(cached: T[], selector: { choices: T[] } | null): T[] {
  return selector?.choices ?? cached
}

export function removeAgent(list: AcpAgentConfig[], id: string): AcpAgentConfig[] {
  return list.filter((a) => a.id !== id)
}

/** Turn a known/detected agent into a config entry ready to persist (env values blanked). */
export function knownToConfig(known: KnownAcpAgent): AcpAgentConfig {
  const env = known.envHints?.length
    ? Object.fromEntries(known.envHints.map((name) => [name, '']))
    : undefined
  return {
    id: known.id,
    title: known.title,
    command: known.command,
    ...(known.args.length ? { args: known.args } : {}),
    ...(env ? { env } : {}),
    enabled: true,
  }
}

export function validateDraft(
  draft: { id: string; title: string; command: string },
  existingIds: readonly string[],
): string | null {
  if (!ID_RE.test(draft.id)) return 'Id must be a lowercase slug (a-z, 0-9, -).'
  if (existingIds.includes(draft.id)) return `An agent with id "${draft.id}" already exists.`
  if (!draft.title.trim()) return 'Title is required.'
  if (!draft.command.trim()) return 'Command is required.'
  return null
}

/** A label + monospace command + copy button (used for install / sign-in lines). */
function commandRow(label: string, command: string): HTMLElement {
  const code = el('code', { class: 'acp-cmd' }, command)
  const copy = el('button', { type: 'button', class: 'acp-cmd-copy', title: 'Copy' }, 'Copy')
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(command)
  })
  return el(
    'div',
    { class: 'acp-cmd-row' },
    el('span', { class: 'acp-cmd-label' }, label),
    code,
    copy,
  )
}

/** Installed/running badge for a known agent, based on the last device scan. */
function detectedStatus(detected: DetectedAcpAgent | undefined): HTMLElement {
  const installed = detected?.installed ?? false
  const status = el('span', { class: `acp-known-status ${installed ? 'ok' : 'missing'}` })
  status.append(
    inlineStatus(
      installed ? 'ok' : 'idle',
      installed ? `installed${detected?.running ? ' · running' : ''}` : 'not installed',
    ),
  )
  return status
}

export function createAcpAgentsSection(api: ApiClient): AcpAgentsSection {
  let agents: AcpAgentConfig[] = []
  let detectedById = new Map<string, DetectedAcpAgent>()
  const knownById = new Map(KNOWN_ACP_AGENTS.map((k) => [k.id, k]))

  // The selected chip. Empty until the first refresh picks a sensible default
  // (a configured agent if there is one, else the first known agent).
  let selected = ''

  const chipRow = el('div', { class: 'provider-chips', role: 'tablist' })
  const formHost = el('div', { class: 'provider-form-host' })
  const scanStatus = el('span', { class: 'key-status' })

  const rescanBtn = el('button', { type: 'button' }, 'Re-scan device')
  rescanBtn.addEventListener('click', () => void scan())

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'ACP agents'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Drive an external coding agent that runs locally on this device (Gemini CLI, ' +
        'Claude Code, …) over the Agent Client Protocol. The agent is a separate program, ' +
        'not bundled with Copse — install it with the command shown, then sign it in. ' +
        'Pick an agent below to install, add, or configure it; added agents appear in the ' +
        'model picker as their own group. Open a folder before using one, since it acts in ' +
        "that workspace and its writes go through Copse's diff-approval queue. Not available " +
        'in SSH remote workspaces (agents are not spawned on the remote host).',
    ),
    el('div', { class: 'provider-actions' }, rescanBtn, scanStatus),
    chipRow,
    formHost,
  )

  async function persist(next: AcpAgentConfig[]): Promise<void> {
    agents = next
    await api.settings.set('registeredAcpAgents', agents)
    render()
  }

  async function scan(): Promise<void> {
    setInlineStatus(scanStatus, 'pending', 'Scanning…')
    scanStatus.className = 'key-status'
    try {
      const found = await api.acp.detectAgents()
      detectedById = new Map(found.map((agent) => [agent.id, agent]))
      const installed = found.filter((agent) => agent.installed).length
      if (installed) setInlineStatus(scanStatus, 'ok', `${String(installed)} installed`)
      else scanStatus.textContent = 'None installed yet'
      scanStatus.className = `key-status ${installed ? 'ok' : ''}`
    } catch {
      detectedById = new Map()
      setInlineStatus(scanStatus, 'error', 'Could not scan')
      scanStatus.className = 'key-status err'
    }
    // A fresh scan updates install/running badges. Re-render the chips, and the
    // open form too — unless it's a configured agent being edited, whose unsaved
    // field edits we don't want to discard for a badge refresh.
    renderChips()
    if (selected === 'other' || !agents.some((a) => a.id === selected)) renderForm()
  }

  /** Chip keys in display order: known agents, then custom-configured, then "Add". */
  function chipKeys(): string[] {
    const ordered: string[] = KNOWN_ACP_AGENTS.map((k) => k.id)
    for (const a of agents) if (!ordered.includes(a.id)) ordered.push(a.id)
    ordered.push('other')
    return ordered
  }

  function chipLabel(key: string): string {
    if (key === 'other') return 'Add agent'
    return knownById.get(key)?.title ?? agents.find((a) => a.id === key)?.title ?? key
  }

  /** Land on the first configured agent when there is one, else the first known. */
  function defaultSelected(): string {
    const configured = chipKeys().find((k) => k !== 'other' && agents.some((a) => a.id === k))
    return configured ?? KNOWN_ACP_AGENTS[0]?.id ?? 'other'
  }

  function renderChips(): void {
    clear(chipRow)
    for (const key of chipKeys()) {
      const chip = el(
        'button',
        { type: 'button', class: 'provider-chip', role: 'tab' },
        chipLabel(key),
      )
      chip.dataset['agent'] = key
      chip.classList.toggle('active', key === selected)
      if (key !== 'other' && agents.some((a) => a.id === key)) {
        chip.append(el('span', { class: 'provider-chip-dot', title: 'Added' }))
      }
      chip.addEventListener('click', () => {
        selected = key
        renderChips()
        renderForm()
      })
      chipRow.append(chip)
    }
  }

  function agentForm(options: {
    initial?: AcpAgentConfig
    submitLabel: string
    onSubmit: (draft: AcpAgentConfig) => void
  }): HTMLElement {
    const isEdit = Boolean(options.initial)
    const idInput = el('input', {
      type: 'text',
      placeholder: 'gemini-cli',
      autocomplete: 'off',
      ...(isEdit ? { readonly: true } : {}),
    })
    const titleInput = el('input', { type: 'text', autocomplete: 'off' })
    const commandInput = el('input', {
      type: 'text',
      placeholder: 'gemini',
      autocomplete: 'off',
    })
    const argsArea = el('textarea', {
      rows: '2',
      spellcheck: false,
      placeholder: 'one argument per line, e.g. --experimental-acp',
    })
    const envArea = el('textarea', {
      rows: '2',
      spellcheck: false,
      placeholder: 'KEY=value per line',
    })
    const enabledBox = el('input', { type: 'checkbox', checked: true })
    const status = el('span', { class: 'key-status' })

    // Model picker: starts with just "Agent default"; "Detect models" probes the
    // agent (spawns it, opens a throwaway session) and fills in its choices.
    const DEFAULT_MODEL_LABEL = 'Agent default'
    const modelSelect = el('select', {})
    const detectModels = el(
      'button',
      { type: 'button', class: 'provider-secondary' },
      'Detect models',
    )
    const modelRow = el('div', { class: 'acp-model-row' }, modelSelect, detectModels)
    const modelStatus = el('span', { class: 'field-hint' })

    // Permission-mode picker (issue #607): the ACP session mode the agent starts
    // each session in. "Agent default" leaves the agent's own prompting alone
    // (sandboxed Claude presets still auto-relax to acceptEdits at spawn time —
    // that default only applies when this is unset). Filled by "Detect models".
    const DEFAULT_MODE_LABEL = 'Agent default'
    const modeSelect = el('select', {})
    const setModeOptions = (choices: AcpModeChoice[], selected: string): void => {
      modeSelect.replaceChildren(el('option', { value: '' }, DEFAULT_MODE_LABEL))
      for (const choice of choices) {
        modeSelect.append(
          el(
            'option',
            { value: choice.value, ...(choice.description ? { title: choice.description } : {}) },
            choice.label,
          ),
        )
      }
      // Preserve a saved value even if it isn't in the (not-yet-detected) list.
      if (selected && !choices.some((c) => c.value === selected)) {
        modeSelect.append(el('option', { value: selected }, `${selected} (saved)`))
      }
      modeSelect.value = selected
    }

    if (options.initial) {
      idInput.value = options.initial.id
      titleInput.value = options.initial.title
      commandInput.value = options.initial.command
      argsArea.value = formatArgsText(options.initial.args)
      envArea.value = formatEnvText(options.initial.env)
      enabledBox.checked = options.initial.enabled
    }
    // Cached list persisted with the agent so the model picker can list models
    // without re-spawning; seeded from the saved config, refreshed by "Detect".
    let detectedModels: AcpModelChoice[] = options.initial?.availableModels ?? []
    // Probe time behind detectedModels, carried across a plain Save and stamped
    // fresh by "Detect models" so the background staleness check can age it out.
    let detectedModelsAt: number | undefined = options.initial?.modelsProbedAt
    const initialModel = options.initial?.model ?? ''
    modelSelect.append(el('option', { value: initialModel }, initialModel || DEFAULT_MODEL_LABEL))
    modelSelect.value = initialModel
    let detectedModes: AcpModeChoice[] = options.initial?.availablePermissionModes ?? []
    setModeOptions(detectedModes, options.initial?.permissionMode ?? '')
    const modelPicker = mountModelSelectPicker(modelSelect, {
      loadOptions: (current): Promise<ModelOption[]> => {
        const pickerOptions: ModelOption[] = [
          { value: '', label: DEFAULT_MODEL_LABEL },
          ...detectedModels.map((choice) => ({ ...choice, group: 'Detected models' })),
        ]
        // Preserve a saved value even if it isn't in the (not-yet-detected) list.
        if (current && !detectedModels.some((choice) => choice.value === current)) {
          pickerOptions.push({ value: current, label: `${current} (saved)` })
        }
        return Promise.resolve(pickerOptions)
      },
      ariaLabel: 'ACP agent model',
      loadOnMount: false,
    })
    void modelPicker.refresh(initialModel)

    // Detection resolves the agent by its saved id, so it only works once the
    // agent has been saved (a fresh, unsaved agent has nothing to spawn yet).
    detectModels.disabled = !isEdit
    if (!isEdit) modelStatus.textContent = 'Save the agent first, then detect its models.'
    detectModels.addEventListener('click', () => {
      const id = idInput.value.trim()
      detectModels.disabled = true
      setInlineStatus(modelStatus, 'pending', 'Detecting… (starting the agent)')
      void api.acp
        .probeAgent(id)
        .then((probe) => {
          detectedModels = selectorChoicesAfterProbe(detectedModels, probe.models)
          detectedModes = selectorChoicesAfterProbe(detectedModes, probe.modes)
          if (probe.models) {
            void modelPicker.refresh(modelSelect.value || probe.models.currentValue)
          }
          if (probe.modes) {
            setModeOptions(probe.modes.choices, modeSelect.value || probe.modes.currentValue)
          }
          // Persist immediately so the detected models/modes appear without a
          // separate Save. Merge onto the *saved* config (not the in-progress form
          // draft) so any unsaved field edits aren't clobbered, and skip the full
          // re-render so this form stays as the user left it.
          detectedModelsAt = Date.now()
          const saved = agents.find((candidate) => candidate.id === id)
          if (saved) {
            agents = upsertAgent(agents, {
              ...saved,
              ...(probe.models ? { availableModels: probe.models.choices } : {}),
              ...(probe.modes ? { availablePermissionModes: probe.modes.choices } : {}),
              modelsProbedAt: detectedModelsAt,
            })
            void api.settings.set('registeredAcpAgents', agents)
          }
          const bits = [
            probe.models
              ? `${String(probe.models.choices.length)} models (default: ${probe.models.currentValue})`
              : 'no selectable models',
            probe.modes ? `${String(probe.modes.choices.length)} permission modes` : '',
          ].filter(Boolean)
          setInlineStatus(modelStatus, 'ok', `Detected ${bits.join(', ')}.`)
        })
        .catch((err: unknown) => {
          setInlineStatus(modelStatus, 'error', err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          detectModels.disabled = false
        })
    })
    // For a new agent, predict the id from the title until the user edits id.
    let idEdited = isEdit
    idInput.addEventListener('input', () => {
      idEdited = true
    })
    titleInput.addEventListener('input', () => {
      if (!idEdited) idInput.value = slugify(titleInput.value)
    })

    const submit = el('button', { type: 'button', class: 'provider-save' }, options.submitLabel)
    submit.addEventListener('click', () => {
      const id = idInput.value.trim()
      const draft = { id, title: titleInput.value.trim(), command: commandInput.value.trim() }
      const existingIds = isEdit ? [] : agents.map((a) => a.id)
      const error = validateDraft(draft, existingIds)
      if (error) {
        setInlineStatus(status, 'error', error)
        status.className = 'key-status err'
        return
      }
      const env = parseEnvText(envArea.value)
      const args = parseArgsText(argsArea.value)
      const model = modelSelect.value.trim()
      const permissionMode = modeSelect.value.trim()
      options.onSubmit({
        id,
        title: draft.title,
        command: draft.command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(model ? { model } : {}),
        ...(detectedModels.length ? { availableModels: detectedModels } : {}),
        ...(detectedModels.length && detectedModelsAt !== undefined
          ? { modelsProbedAt: detectedModelsAt }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(detectedModes.length ? { availablePermissionModes: detectedModes } : {}),
        enabled: enabledBox.checked,
      })
    })

    const fields = el(
      'div',
      { class: 'acp-agent-fields' },
      el('label', {}, 'Id', idInput),
      el('label', {}, 'Title', titleInput),
      el('label', {}, 'Command', commandInput),
      el('label', {}, 'Arguments', argsArea),
      el('label', {}, 'Environment', envArea),
      el('label', {}, 'Model', modelRow, modelStatus),
      el(
        'label',
        { class: 'acp-permission-mode-field' },
        'Permission mode',
        modeSelect,
        el(
          'span',
          { class: 'field-hint' },
          'ACP session mode. Relaxes or tightens the agent’s own approval prompting. ' +
            'Sandboxed Claude presets default to acceptEdits.',
        ),
      ),
      el('label', { class: 'checkbox-label' }, enabledBox, ' Enabled (shown in the model picker)'),
    )
    const actions = el('div', { class: 'provider-actions provider-form-footer' }, submit, status)
    return el('div', { class: 'acp-agent-form' }, fields, actions)
  }

  /** Preinstall guidance + one-click add for a known agent that isn't configured yet. */
  function knownForm(known: KnownAcpAgent): HTMLElement {
    const detected = detectedById.get(known.id)
    const installed = detected?.installed ?? false
    const form = el(
      'div',
      { class: 'provider-form' },
      el('h4', { class: 'provider-form-title' }, known.title, detectedStatus(detected)),
    )
    if (!installed && known.install) form.append(commandRow('Install', known.install))
    if (known.setup) form.append(commandRow('Sign in', known.setup))
    if (known.note) form.append(el('p', { class: 'field-hint' }, known.note))
    if (known.docsUrl) {
      form.append(
        el(
          'p',
          { class: 'field-hint' },
          el(
            'a',
            { href: known.docsUrl, target: '_blank', rel: 'noopener noreferrer' },
            'Documentation',
          ),
        ),
      )
    }
    const add = el('button', { type: 'button', class: 'provider-save' }, 'Add to my agents')
    add.addEventListener('click', () => {
      selected = known.id
      void persist(upsertAgent(agents, knownToConfig(known)))
    })
    form.append(el('div', { class: 'provider-actions provider-form-footer' }, add))
    return form
  }

  /** Editable card for a configured agent (known preset or a custom entry). */
  function configuredForm(agent: AcpAgentConfig): HTMLElement {
    const known = knownById.get(agent.id)
    const remove = el('button', { type: 'button', class: 'provider-delete' }, 'Remove')
    remove.addEventListener('click', () => {
      // A custom agent's chip disappears on removal, so fall back to the default
      // selection; a known agent keeps its chip (its guidance form returns).
      if (!knownById.has(agent.id)) selected = ''
      void persist(removeAgent(agents, agent.id))
    })
    const card = el(
      'div',
      { class: 'acp-agent-card' },
      el(
        'div',
        { class: 'acp-agent-card-head' },
        el('strong', {}, agent.title),
        el('code', {}, `acp:${agent.id}`),
        ...(known ? [detectedStatus(detectedById.get(known.id))] : []),
        remove,
      ),
    )
    // Keep install/sign-in guidance to hand even after adding a known agent.
    if (known) {
      const installed = detectedById.get(known.id)?.installed ?? false
      if (!installed && known.install) card.append(commandRow('Install', known.install))
      if (known.setup) card.append(commandRow('Sign in', known.setup))
    }
    card.append(
      agentForm({
        initial: agent,
        submitLabel: 'Save',
        onSubmit: (draft) => void persist(upsertAgent(agents, draft)),
      }),
    )
    return card
  }

  /** The "Add agent" chip: a blank form for any ACP-speaking command. */
  function addForm(): HTMLElement {
    return el(
      'div',
      { class: 'provider-form' },
      el('h4', { class: 'provider-form-title' }, 'Add a custom agent'),
      el(
        'p',
        { class: 'field-hint' },
        'Point Copse at any command that speaks ACP over stdio. Give it an id, the ' +
          'command to launch, and the arguments that put it into ACP mode.',
      ),
      agentForm({
        submitLabel: 'Add agent',
        onSubmit: (draft) => {
          selected = draft.id
          void persist(upsertAgent(agents, draft))
        },
      }),
    )
  }

  function renderForm(): void {
    clear(formHost)
    if (selected === 'other') {
      formHost.append(addForm())
      return
    }
    const configured = agents.find((a) => a.id === selected)
    if (configured) {
      formHost.append(configuredForm(configured))
      return
    }
    const known = knownById.get(selected)
    if (known) formHost.append(knownForm(known))
  }

  function render(): void {
    // Keep the selection valid as agents are added/removed (or on first paint).
    if (selected !== 'other' && !chipKeys().includes(selected)) selected = defaultSelected()
    renderChips()
    renderForm()
  }

  async function reloadAgents(): Promise<void> {
    try {
      agents = parseAcpAgentConfigs(await api.settings.get('registeredAcpAgents'))
    } catch {
      agents = []
    }
  }

  // "Just works" setup: detect clients, install missing npm adapters (Socket
  // Firewall), register the Claude/Cursor presets, and cache their models. Runs
  // once per tab open; idempotent, best-effort, and never throws to the UI.
  async function autoSetup(): Promise<void> {
    try {
      const result = await api.acp.autoSetup()
      if (result.installed.length || result.registered.length || result.modelsDetected.length) {
        await reloadAgents()
        render()
        await scan()
        const bits = [
          result.installed.length ? `installed ${String(result.installed.length)}` : '',
          result.registered.length ? `added ${String(result.registered.length)}` : '',
          // Only worth calling out when nothing was installed/added (a pure model refresh).
          !result.installed.length && !result.registered.length && result.modelsDetected.length
            ? `detected models for ${String(result.modelsDetected.length)}`
            : '',
        ].filter(Boolean)
        if (bits.length) {
          setInlineStatus(scanStatus, 'ok', `Presets ready (${bits.join(', ')})`)
          scanStatus.className = 'key-status ok'
        }
      }
    } catch {
      /* best-effort — the manual known-agents list still works */
    }
  }

  async function refresh(): Promise<void> {
    await reloadAgents()
    render()
    await scan()
    await autoSetup()
  }

  return { root: fieldset, refresh }
}
