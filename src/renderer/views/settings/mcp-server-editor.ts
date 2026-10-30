import type { ApiClient } from '../../../preload/api.d.ts'
import type {
  McpSecretEntryInput,
  McpStoredSecretKey,
  McpUserServer,
  McpUserServerField,
  McpUserServerInput,
  McpUserServerList,
} from '@shared/types/mcp-user-servers.ts'
import { el } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import { ipcErrorMessage } from '../../ipc-error-message.ts'

export interface McpServerEditor {
  /** Open the form empty (`undefined`) or filled from a server in Copse's config. */
  open(server?: McpUserServer): void
  close(): void
}

interface SecretRows {
  root: HTMLElement
  entries(): McpSecretEntryInput[]
  reset(stored: readonly McpStoredSecretKey[]): void
}

/**
 * Key / value rows for env vars or headers. A stored value never reaches the
 * renderer: its row shows the key with an empty password field, and leaving
 * that field empty keeps what is saved.
 */
function secretRows(kind: 'env' | 'headers'): SecretRows {
  const noun = kind === 'env' ? 'variable' : 'header'
  const list = el('div', { class: 'mcp-editor-secret-list' })
  const addButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact' },
    kind === 'env' ? 'Add variable' : 'Add header',
  )
  const rows: { key: HTMLInputElement; value: HTMLInputElement; stored: boolean }[] = []

  function addRow(key = '', stored = false): void {
    const keyInput = el('input', {
      type: 'text',
      class: 'mcp-editor-secret-key',
      placeholder: kind === 'env' ? 'NAME' : 'Header-Name',
      'aria-label': kind === 'env' ? 'Variable name' : 'Header name',
      spellcheck: 'false',
      autocomplete: 'off',
    })
    keyInput.value = key
    const valueInput = el('input', {
      type: 'password',
      class: 'mcp-editor-secret-value',
      placeholder: stored ? 'Saved value (unchanged)' : 'Value',
      'aria-label':
        kind === 'env' ? `Value of ${key || 'variable'}` : `Value of ${key || 'header'}`,
      autocomplete: 'new-password',
    })
    const row = { key: keyInput, value: valueInput, stored }
    const removeButton = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-secondary ui-btn-compact mcp-editor-secret-remove',
        'aria-label': `Remove ${noun}`,
        title: `Remove ${noun}`,
      },
      '×',
    )
    const line = el('div', { class: 'mcp-editor-secret-row' }, keyInput, valueInput, removeButton)
    removeButton.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1)
      line.remove()
    })
    // A renamed key is a new entry: it has no saved value to fall back on.
    keyInput.addEventListener('input', () => {
      if (!row.stored) return
      row.stored = false
      valueInput.placeholder = 'Value'
    })
    rows.push(row)
    list.append(line)
  }

  addButton.addEventListener('click', () => {
    addRow()
    rows.at(-1)?.key.focus()
  })

  return {
    root: el('div', { class: 'mcp-editor-secrets' }, list, addButton),
    entries: () =>
      rows.map(({ key, value, stored }) =>
        value.value === '' && stored ? { key: key.value } : { key: key.value, value: value.value },
      ),
    reset: (stored): void => {
      rows.splice(0)
      list.replaceChildren()
      for (const entry of stored) addRow(entry.key, true)
    },
  }
}

function labelled(text: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const label = el('label', {}, text, control)
  if (hint !== undefined) label.append(el('span', { class: 'field-hint' }, hint))
  return label
}

/**
 * The add / edit form for Copse's own `mcp.json`. It sits inline under the
 * server list (Settings is a page, not a stack of dialogs) and validates in the
 * main process, which owns the file and the names other sources already use.
 */
export function createMcpServerEditor(
  host: HTMLElement,
  api: ApiClient,
  onSaved: (list: McpUserServerList) => void,
): McpServerEditor {
  let editing: string | undefined

  const heading = el('h4', { class: 'mcp-editor-heading' })
  const nameInput = el('input', {
    type: 'text',
    id: 'mcp-editor-name',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'my-server',
  })
  const transportSelect = el(
    'select',
    { id: 'mcp-editor-transport' },
    el('option', { value: 'stdio' }, 'Local command (stdio)'),
    el('option', { value: 'http' }, 'Remote URL (HTTP)'),
  )
  const commandInput = el('input', {
    type: 'text',
    id: 'mcp-editor-command',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'npx',
  })
  const argsInput = el('textarea', {
    id: 'mcp-editor-args',
    rows: '3',
    spellcheck: 'false',
    placeholder: '-y\n@modelcontextprotocol/server-everything',
  })
  const cwdInput = el('input', {
    type: 'text',
    id: 'mcp-editor-cwd',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  const urlInput = el('input', {
    type: 'url',
    id: 'mcp-editor-url',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'https://example.com/mcp',
  })
  const env = secretRows('env')
  const headers = secretRows('headers')
  const envGroup = el(
    'div',
    { class: 'mcp-editor-group' },
    el('span', { class: 'mcp-editor-group-label' }, 'Environment variables'),
    env.root,
  )
  const headersGroup = el(
    'div',
    { class: 'mcp-editor-group' },
    el('span', { class: 'mcp-editor-group-label' }, 'Headers'),
    headers.root,
  )

  const stdioFields = el(
    'div',
    { class: 'mcp-editor-transport-fields', 'data-transport': 'stdio' },
    labelled(
      'Command',
      commandInput,
      'The program that starts the server, such as npx, uvx or a path.',
    ),
    labelled('Arguments', argsInput, 'One argument per line.'),
    labelled('Working directory (optional)', cwdInput),
    envGroup,
  )
  const httpFields = el(
    'div',
    { class: 'mcp-editor-transport-fields', 'data-transport': 'http' },
    labelled(
      'URL',
      urlInput,
      'Servers that use OAuth need no header: save, then choose Sign in on the server.',
    ),
    headersGroup,
  )
  const secretsHint = el(
    'p',
    { class: 'field-hint mcp-editor-secrets-hint' },
    'Values are saved as plain text in Copse’s MCP config, readable only by your user account. ' +
      'To keep a key out of the file, enter ',
    el('code', {}, '${env:NAME}'),
    ' and Copse reads it from its environment.',
  )

  const status = el('span', { class: 'lmstudio-test-status', id: 'mcp-editor-status' })
  const saveButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary', id: 'mcp-editor-save' },
    'Save server',
  )
  const cancelButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary', id: 'mcp-editor-cancel' },
    'Cancel',
  )

  const fieldControls: Partial<Record<McpUserServerField, HTMLElement>> = {
    name: nameInput,
    command: commandInput,
    cwd: cwdInput,
    url: urlInput,
    env: envGroup,
    headers: headersGroup,
  }

  host.replaceChildren(
    heading,
    labelled('Name', nameInput, 'Tools appear to the agent as mcp__<name>__<tool>.'),
    labelled('Type', transportSelect),
    stdioFields,
    httpFields,
    secretsHint,
    el('div', { class: 'settings-action-row' }, saveButton, cancelButton, status),
  )

  function clearInvalid(): void {
    for (const control of Object.values(fieldControls)) control.removeAttribute('aria-invalid')
    status.replaceChildren()
  }

  function syncTransport(): void {
    const http = transportSelect.value === 'http'
    stdioFields.hidden = http
    httpFields.hidden = !http
  }

  function input(): McpUserServerInput {
    if (transportSelect.value === 'http') {
      return {
        transport: 'http',
        name: nameInput.value,
        url: urlInput.value,
        headers: headers.entries(),
      }
    }
    const cwd = cwdInput.value.trim()
    return {
      transport: 'stdio',
      name: nameInput.value,
      command: commandInput.value,
      args: argsInput.value.split('\n').map((arg) => arg.trim()),
      ...(cwd ? { cwd } : {}),
      env: env.entries(),
    }
  }

  function open(server?: McpUserServer): void {
    editing = server?.name
    heading.textContent = server ? `Edit ${server.name}` : 'Add an MCP server'
    nameInput.value = server?.name ?? ''
    transportSelect.value = server?.transport ?? 'stdio'
    commandInput.value = server?.transport === 'stdio' ? server.command : ''
    argsInput.value = server?.transport === 'stdio' ? server.args.join('\n') : ''
    cwdInput.value = server?.transport === 'stdio' ? (server.cwd ?? '') : ''
    urlInput.value = server?.transport === 'http' ? server.url : ''
    env.reset(server?.transport === 'stdio' ? server.env : [])
    headers.reset(server?.transport === 'http' ? server.headers : [])
    clearInvalid()
    syncTransport()
    host.hidden = false
    nameInput.focus()
  }

  function close(): void {
    editing = undefined
    host.hidden = true
    clearInvalid()
  }

  async function save(): Promise<void> {
    clearInvalid()
    saveButton.disabled = true
    status.textContent = 'Saving…'
    try {
      const result = await api.mcp.saveUserServer(input(), editing)
      if (!result.ok) {
        const control = fieldControls[result.field]
        control?.setAttribute('aria-invalid', 'true')
        setInlineStatus(status, 'error', result.message)
        const focusTarget =
          control instanceof HTMLInputElement ? control : control?.querySelector('input')
        focusTarget?.focus()
        return
      }
      close()
      onSaved(result.list)
    } catch (error: unknown) {
      setInlineStatus(status, 'error', ipcErrorMessage(error, 'Could not save the server.'))
    } finally {
      saveButton.disabled = false
    }
  }

  transportSelect.addEventListener('change', syncTransport)
  saveButton.addEventListener('click', () => {
    void save()
  })
  cancelButton.addEventListener('click', close)
  host.addEventListener('input', (event) => {
    const target = event.target
    if (target instanceof HTMLElement) {
      target.removeAttribute('aria-invalid')
      target.closest('[aria-invalid]')?.removeAttribute('aria-invalid')
    }
  })
  // The editor sits inside the Settings form: Enter in one of its fields would
  // otherwise submit (and close) Settings instead of saving the server.
  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target instanceof HTMLTextAreaElement) return
    if (!(event.target instanceof HTMLInputElement)) return
    event.preventDefault()
    void save()
  })

  host.hidden = true
  return { open, close }
}
