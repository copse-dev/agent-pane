import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot } from '@shared/settings-contract.ts'
import { SANDBOX_READ_WORKSPACE_ONLY_SETTING } from '@shared/sandbox-read-access.ts'
import { clear, el, qsRequired } from '../../dom/helpers.ts'
import { inputControl } from './fields.ts'

/** The folder's last path segment, the part a person recognises at a glance. */
function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

export interface SandboxReadSection {
  refresh(snapshot: SettingsSnapshot): void
}

/**
 * Settings → Permissions → Sandbox read access: the approved-folder list with
 * a Remove button per folder, and the workspace-only lockdown greying out the
 * group switches it overrides. The switches themselves are plain fields
 * (`permissionsFields`) saved with the form.
 */
export function createSandboxReadSection(
  form: HTMLFormElement,
  api: ApiClient,
): SandboxReadSection {
  const host = qsRequired(form, '#sandbox-read-folders-host')
  const lockdown = inputControl(form, SANDBOX_READ_WORKSPACE_ONLY_SETTING)
  const groups = [...form.querySelectorAll<HTMLInputElement>('input[data-sandbox-read-group]')]

  const syncLockdown = (): void => {
    for (const input of groups) input.disabled = lockdown.checked
  }
  lockdown.addEventListener('change', syncLockdown)

  const render = (folders: Record<string, string[]>): void => {
    clear(host)
    const projects = Object.entries(folders).filter(([, paths]) => paths.length > 0)
    if (projects.length === 0) {
      host.append(el('p', { class: 'field-hint' }, 'No folders approved yet.'))
      return
    }
    for (const [projectRoot, paths] of projects.sort(([a], [b]) => a.localeCompare(b))) {
      const list = el('ul', { class: 'sandbox-read-folder-list' })
      for (const path of paths) {
        const remove = el(
          'button',
          {
            type: 'button',
            class: 'ui-btn ui-btn-secondary ui-btn-compact',
            'aria-label': `Remove ${path} from ${folderName(projectRoot)}`,
          },
          'Remove',
        )
        remove.addEventListener('click', () => {
          remove.disabled = true
          void api.settings
            .revokeSandboxReadFolder(projectRoot, path)
            .then(async () => {
              const snapshot = await api.settings.getSnapshot()
              render(snapshot.sandboxReadProjectFolders ?? {})
            })
            .catch(() => {
              remove.disabled = false
            })
        })
        list.append(
          el(
            'li',
            { class: 'sandbox-read-folder-row', 'data-folder': path },
            el('code', { class: 'sandbox-read-folder-path' }, path),
            remove,
          ),
        )
      }
      host.append(
        el(
          'div',
          { class: 'sandbox-read-project', 'data-project': projectRoot },
          el(
            'span',
            { class: 'sandbox-read-project-name', title: projectRoot },
            folderName(projectRoot),
          ),
          list,
        ),
      )
    }
  }

  return {
    refresh(snapshot): void {
      render(snapshot.sandboxReadProjectFolders ?? {})
      syncLockdown()
    },
  }
}
