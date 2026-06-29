import type { ApiClient } from '../../../preload/api.d.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import type { DetectedAcpAgent } from '@shared/acp-known-agents.ts'
import { el, clear } from '../../dom/helpers.ts'

// Settings panel for external ACP agents Copse drives as a client (the `acp:<id>`
// models). CRUD over the `registeredAcpAgents` setting, plus a "Detect" button
// that scans the device (acp:detectAgents) and one-click adds what it finds.
//
// Pure helpers (parse/format/upsert) are exported and unit-tested; the rest is
// thin DOM glue that persists on every change via settings.set.

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

/** Turn a detected agent into a config entry ready to persist (env values blanked). */
export function detectedToConfig(detected: DetectedAcpAgent): AcpAgentConfig {
  const env = detected.envHints?.length
    ? Object.fromEntries(detected.envHints.map((name) => [name, '']))
    : undefined
  return {
    id: detected.id,
    title: detected.title,
    command: detected.command,
    ...(detected.args.length ? { args: detected.args } : {}),
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

export function createAcpAgentsSection(api: ApiClient): AcpAgentsSection {
  let agents: AcpAgentConfig[] = []

  const listHost = el('div', { class: 'acp-agent-list' })
  const detectStatus = el('span', { class: 'key-status' })
  const detectResults = el('div', { class: 'acp-detect-results' })
  const addHost = el('div', { class: 'acp-agent-add' })

  const detectBtn = el('button', { type: 'button' }, 'Detect installed agents')
  detectBtn.addEventListener('click', () => void runDetect())

  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'ACP agents'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Drive an external coding agent that runs locally on this device (Gemini CLI, ' +
        'Claude Code, …) over the Agent Client Protocol. Configured agents appear in the ' +
        'model picker as their own group. Open a folder before using one — the agent acts ' +
        'in that workspace, and its file writes go through the diff-approval queue.',
    ),
    el('div', { class: 'provider-actions' }, detectBtn, detectStatus),
    detectResults,
    listHost,
    addHost,
  )

  async function persist(next: AcpAgentConfig[]): Promise<void> {
    agents = next
    await api.settings.set('registeredAcpAgents', agents)
    render()
  }

  async function runDetect(): Promise<void> {
    detectStatus.textContent = 'Scanning…'
    detectStatus.className = 'key-status'
    clear(detectResults)
    let found: DetectedAcpAgent[]
    try {
      found = await api.acp.detectAgents()
    } catch {
      detectStatus.textContent = '✗ Could not scan'
      detectStatus.className = 'key-status err'
      return
    }
    const installed = found.filter((agent) => agent.installed)
    detectStatus.textContent = installed.length
      ? `✓ Found ${String(installed.length)} installed`
      : 'No known agents found on PATH'
    detectStatus.className = `key-status ${installed.length ? 'ok' : ''}`

    for (const agent of installed) {
      const already = agents.some((a) => a.id === agent.id)
      const add = el(
        'button',
        { type: 'button', ...(already ? { disabled: true } : {}) },
        already ? 'Added' : 'Add',
      )
      add.addEventListener('click', () => {
        void persist(upsertAgent(agents, detectedToConfig(agent)))
      })
      const meta = [agent.command, agent.running ? 'running now' : ''].filter(Boolean).join(' · ')
      detectResults.append(
        el('div', { class: 'acp-detect-row' }, el('span', {}, `${agent.title} (${meta})`), add),
      )
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

    if (options.initial) {
      idInput.value = options.initial.id
      titleInput.value = options.initial.title
      commandInput.value = options.initial.command
      argsArea.value = formatArgsText(options.initial.args)
      envArea.value = formatEnvText(options.initial.env)
      enabledBox.checked = options.initial.enabled
    }
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
        status.textContent = `✗ ${error}`
        status.className = 'key-status err'
        return
      }
      const env = parseEnvText(envArea.value)
      const args = parseArgsText(argsArea.value)
      options.onSubmit({
        id,
        title: draft.title,
        command: draft.command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
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
      el('label', { class: 'checkbox-label' }, enabledBox, ' Enabled (shown in the model picker)'),
    )
    const actions = el('div', { class: 'provider-actions provider-form-footer' }, submit, status)
    return el('div', { class: 'acp-agent-form' }, fields, actions)
  }

  function render(): void {
    clear(listHost)
    if (agents.length === 0) {
      listHost.append(
        el('p', { class: 'field-hint' }, 'No ACP agents configured yet. Detect or add one below.'),
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

  async function refresh(): Promise<void> {
    try {
      agents = ((await api.settings.get('registeredAcpAgents')) as AcpAgentConfig[] | null) ?? []
    } catch {
      agents = []
    }
    clear(detectResults)
    detectStatus.textContent = ''
    render()
  }

  return { root: fieldset, refresh }
}
