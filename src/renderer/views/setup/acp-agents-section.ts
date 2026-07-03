import type { ApiClient } from '../../../preload/api.d.ts'
import type { AcpAgentConfig, AcpModelChoice } from '@shared/types/acp.ts'
import {
  KNOWN_ACP_AGENTS,
  type DetectedAcpAgent,
  type KnownAcpAgent,
} from '@shared/acp-known-agents.ts'
import { el, clear } from '../../dom/helpers.ts'
import { inlineStatus, setInlineStatus } from '../../dom/inline-status.ts'

// Settings panel for external ACP agents Copse drives as a client (the `acp:<id>`
// models). It scans the device (acp:detectAgents) and lists the known agents with
// their install + sign-in commands ("preinstall" guidance), one-click add, plus a
// CRUD editor over the `registeredAcpAgents` setting for configured/custom agents.
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

export function createAcpAgentsSection(api: ApiClient): AcpAgentsSection {
  let agents: AcpAgentConfig[] = []
  let detectedById = new Map<string, DetectedAcpAgent>()

  const knownHost = el('div', { class: 'acp-known-list' })
  const scanStatus = el('span', { class: 'key-status' })
  const listHost = el('div', { class: 'acp-agent-list' })
  const addHost = el('div', { class: 'acp-agent-add' })

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
        'Configured agents appear in the model picker as their own group; open a folder ' +
        "before using one, since it acts in that workspace and its writes go through Copse's " +
        'diff-approval queue.',
    ),
    el('h4', { class: 'provider-form-title' }, 'Known agents'),
    knownHost,
    el('div', { class: 'provider-actions' }, rescanBtn, scanStatus),
    el('h4', { class: 'provider-form-title' }, 'Configured agents'),
    listHost,
    addHost,
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
      else setInlineStatus(scanStatus, 'pending', 'None installed yet')
      scanStatus.className = `key-status ${installed ? 'ok' : ''}`
    } catch {
      detectedById = new Map()
      setInlineStatus(scanStatus, 'error', 'Could not scan')
      scanStatus.className = 'key-status err'
    }
    renderKnown()
  }

  function renderKnown(): void {
    clear(knownHost)
    for (const known of KNOWN_ACP_AGENTS) {
      const detected = detectedById.get(known.id)
      const installed = detected?.installed ?? false
      const configured = agents.some((a) => a.id === known.id)

      const status = el('span', { class: `acp-known-status ${installed ? 'ok' : 'missing'}` })
      status.append(
        inlineStatus(
          installed ? 'ok' : 'pending',
          installed ? `installed${detected?.running ? ' · running' : ''}` : 'not installed',
        ),
      )
      const add = el(
        'button',
        { type: 'button', ...(configured ? { disabled: true } : {}) },
        configured ? 'Added' : 'Add',
      )
      add.addEventListener('click', () => void persist(upsertAgent(agents, knownToConfig(known))))

      const card = el(
        'div',
        { class: 'acp-known-card' },
        el(
          'div',
          { class: 'acp-known-head' },
          el('strong', {}, known.title),
          status,
          el('span', { class: 'acp-known-add' }, add),
        ),
      )
      // Show how to install (only when missing) and how to authenticate.
      if (!installed && known.install) card.append(commandRow('Install', known.install))
      if (known.setup) card.append(commandRow('Sign in', known.setup))
      if (known.note) card.append(el('p', { class: 'field-hint' }, known.note))
      knownHost.append(card)
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
    const setModelOptions = (
      choices: { value: string; label: string }[],
      selected: string,
    ): void => {
      modelSelect.replaceChildren(el('option', { value: '' }, DEFAULT_MODEL_LABEL))
      for (const choice of choices)
        modelSelect.append(el('option', { value: choice.value }, choice.label))
      // Preserve a saved value even if it isn't in the (not-yet-detected) list.
      if (selected && !choices.some((c) => c.value === selected)) {
        modelSelect.append(el('option', { value: selected }, `${selected} (saved)`))
      }
      modelSelect.value = selected
    }
    const detectModels = el(
      'button',
      { type: 'button', class: 'provider-secondary' },
      'Detect models',
    )
    const modelStatus = el('span', { class: 'field-hint' })

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
    setModelOptions(detectedModels, options.initial?.model ?? '')

    // Detection resolves the agent by its saved id, so it only works once the
    // agent has been saved (a fresh, unsaved agent has nothing to spawn yet).
    detectModels.disabled = !isEdit
    if (!isEdit) setInlineStatus(modelStatus, 'pending', 'Save the agent first, then detect its models.')
    detectModels.addEventListener('click', () => {
      const id = idInput.value.trim()
      detectModels.disabled = true
      setInlineStatus(modelStatus, 'pending', 'Detecting… (starting the agent)')
      void api.acp
        .listModels(id)
        .then((selector) => {
          if (!selector) {
            detectedModels = []
            setInlineStatus(modelStatus, 'pending', 'This agent exposes no selectable models.')
            return
          }
          detectedModels = selector.choices
          setModelOptions(selector.choices, modelSelect.value || selector.currentValue)
          // Persist immediately so the models appear in the main picker without a
          // separate Save. Merge onto the *saved* config (not the in-progress form
          // draft) so any unsaved field edits aren't clobbered, and skip the full
          // re-render so this form stays as the user left it.
          const saved = agents.find((candidate) => candidate.id === id)
          if (saved) {
            agents = upsertAgent(agents, { ...saved, availableModels: selector.choices })
            void api.settings.set('registeredAcpAgents', agents)
          }
          setInlineStatus(modelStatus, 'ok', `${String(selector.choices.length)} models added to the picker (default: ${selector.currentValue}).`)
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
      options.onSubmit({
        id,
        title: draft.title,
        command: draft.command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(model ? { model } : {}),
        ...(detectedModels.length ? { availableModels: detectedModels } : {}),
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
      el(
        'label',
        {},
        'Model',
        el('div', { class: 'acp-model-row' }, modelSelect, detectModels),
        modelStatus,
      ),
      el('label', { class: 'checkbox-label' }, enabledBox, ' Enabled (shown in the model picker)'),
    )
    const actions = el('div', { class: 'provider-actions provider-form-footer' }, submit, status)
    return el('div', { class: 'acp-agent-form' }, fields, actions)
  }

  function render(): void {
    renderKnown() // keep the "Add"/"Added" state in sync with the configured list
    clear(listHost)
    if (agents.length === 0) {
      listHost.append(
        el('p', { class: 'field-hint' }, 'No ACP agents configured yet. Add one above or below.'),
      )
    }
    for (const agent of agents) {
      const remove = el('button', { type: 'button', class: 'provider-delete' }, 'Remove')
      remove.addEventListener('click', () => void persist(removeAgent(agents, agent.id)))
      const card = el(
        'div',
        { class: 'acp-agent-card' },
        el(
          'div',
          { class: 'acp-agent-card-head' },
          el('strong', {}, agent.title),
          el('code', {}, `acp:${agent.id}`),
          remove,
        ),
        agentForm({
          initial: agent,
          submitLabel: 'Save',
          onSubmit: (draft) => void persist(upsertAgent(agents, draft)),
        }),
      )
      listHost.append(card)
    }

    clear(addHost)
    addHost.append(
      el('h4', { class: 'provider-form-title' }, 'Add an agent'),
      agentForm({
        submitLabel: 'Add agent',
        onSubmit: (draft) => void persist(upsertAgent(agents, draft)),
      }),
    )
  }

  async function reloadAgents(): Promise<void> {
    try {
      agents = ((await api.settings.get('registeredAcpAgents')) as AcpAgentConfig[] | null) ?? []
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
      if (result.installed.length || result.registered.length) {
        await reloadAgents()
        render()
        await scan()
        const bits = [
          result.installed.length ? `installed ${String(result.installed.length)}` : '',
          result.registered.length ? `added ${String(result.registered.length)}` : '',
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
