import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { el } from '../../dom/helpers.ts'
import {
  emptySshHostDraft,
  nextAvailableHostId,
  parseSshHostDraft,
  slugifyHostId,
  type ParseSshHostDraftResult,
  type SshHostDraft,
} from './ssh-host-helpers.ts'

/**
 * The fields of an SSH host, shared by every place that adds or edits one:
 * Settings → Machines, the Open remote folder dialog and the Desktop pane.
 *
 * Each surface keeps its own frame and buttons; the fields, their names and
 * their validation are the same everywhere. A host's id is internal (projects
 * and settings refer to it), so nobody types one: a new host's id comes from
 * its label, made unique among the saved hosts, and an edited host keeps its id.
 */
export interface SshHostFields {
  /** The labelled fields, in order, ready to place inside a surface's form. */
  readonly fields: HTMLElement[]
  /** Empty every field, ready for a new host. */
  reset(): void
  /** Fill every field from a saved host, which keeps its id when saved. */
  edit(host: SshWorkspaceHost): void
  /** The id being edited, or null for a new host. */
  editingId(): string | null
  /** Validate the fields into a host whose id is unique among `existing`. */
  parse(existing: readonly SshWorkspaceHost[]): ParseSshHostDraftResult
  /** Mark exactly the fields a failed save was about; editing one clears its mark. */
  markInvalid(fields: readonly (keyof SshHostDraft)[]): void
  focus(): void
}

export interface SshHostFieldsOptions {
  /** Class for each field's `<label>`, so the fields take the surface's field recipe. */
  labelClass?: string
}

export function createSshHostFields(options: SshHostFieldsOptions = {}): SshHostFields {
  // Every field names its type so it takes the Settings field recipe (width cap,
  // target height), which is keyed on `input[type=…]`. Port stays `text` with a
  // numeric keypad hint: `type="number"` would hand back '' for "22garbage" and
  // the parser could no longer tell a typo from an empty field.
  const label = el('input', {
    type: 'text',
    name: 'sshHostLabel',
    'aria-label': 'SSH host label',
    placeholder: 'Production',
  })
  const host = el('input', {
    type: 'text',
    name: 'sshHostHost',
    'aria-label': 'SSH hostname',
    placeholder: 'example.com or ~/.ssh/config alias',
  })
  const user = el('input', {
    type: 'text',
    name: 'sshHostUser',
    'aria-label': 'SSH user',
    placeholder: 'ubuntu',
  })
  const port = el('input', {
    type: 'text',
    name: 'sshHostPort',
    'aria-label': 'SSH port',
    placeholder: '22',
    inputmode: 'numeric',
  })
  const identityFile = el('input', {
    type: 'text',
    name: 'sshHostIdentity',
    'aria-label': 'SSH identity file',
    placeholder: '~/.ssh/id_ed25519',
  })
  const forwardAgent = el('input', { type: 'checkbox', name: 'sshHostForwardAgent' })

  const inputs: Partial<Record<keyof SshHostDraft, HTMLInputElement>> = {
    label,
    host,
    user,
    port,
    identityFile,
  }
  for (const input of Object.values(inputs)) {
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid')
    })
  }

  const labelAttrs = options.labelClass ? { class: options.labelClass } : {}
  const fields = [
    el('label', labelAttrs, 'Label ', label),
    el('label', labelAttrs, 'Host ', host),
    el('label', labelAttrs, 'User ', user),
    el('label', labelAttrs, 'Port ', port),
    el('label', labelAttrs, 'Identity file ', identityFile),
    el('label', { class: 'checkbox-label' }, forwardAgent, ' Forward SSH agent'),
  ]

  let editing: string | null = null

  function markInvalid(names: readonly (keyof SshHostDraft)[]): void {
    for (const [field, input] of Object.entries(inputs)) {
      if (names.some((name) => name === field)) input.setAttribute('aria-invalid', 'true')
      else input.removeAttribute('aria-invalid')
    }
  }

  function fill(draft: SshHostDraft): void {
    label.value = draft.label
    host.value = draft.host
    user.value = draft.user
    port.value = draft.port
    identityFile.value = draft.identityFile
    forwardAgent.checked = draft.forwardAgent
  }

  return {
    fields,
    reset(): void {
      editing = null
      markInvalid([])
      fill(emptySshHostDraft())
    },
    edit(saved): void {
      editing = saved.id
      markInvalid([])
      fill({
        id: saved.id,
        label: saved.label,
        host: saved.host,
        user: saved.user ?? '',
        port: saved.port === undefined ? '' : String(saved.port),
        identityFile: saved.identityFile ?? '',
        forwardAgent: saved.forwardAgent === true,
      })
    },
    editingId: (): string | null => editing,
    parse(existing): ParseSshHostDraftResult {
      const used = new Set(
        existing.filter((entry) => entry.id !== editing).map((entry) => entry.id),
      )
      const id = editing ?? nextAvailableHostId(slugifyHostId(label.value || host.value), used)
      const parsed = parseSshHostDraft({
        id,
        label: label.value,
        host: host.value,
        user: user.value,
        port: port.value,
        identityFile: identityFile.value,
        forwardAgent: forwardAgent.checked,
      })
      markInvalid(parsed.ok ? [] : parsed.fields)
      return parsed
    },
    markInvalid,
    focus(): void {
      label.focus()
    },
  }
}
