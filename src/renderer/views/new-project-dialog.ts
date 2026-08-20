import { el, clear } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'

export interface NewProjectPick {
  name: string
  parentDir: string
}

let dialogEl: HTMLDialogElement | null = null

function ensureDialog(): HTMLDialogElement {
  if (dialogEl) return dialogEl
  dialogEl = el('dialog', { id: 'new-project-dialog', class: 'new-project-dialog' })
  document.body.append(dialogEl)
  return dialogEl
}

/**
 * "New project" dialog: type a project/folder name, choose the parent directory
 * (defaults to the last opened project's directory, or home when there is none),
 * then resolve with { name, parentDir } — or null if cancelled.
 */
export function openNewProjectDialog(
  api: ApiClient,
  defaultParentDir: string,
): Promise<NewProjectPick | null> {
  const dialog = ensureDialog()
  clear(dialog)

  const nameInput = el('input', {
    type: 'text',
    class: 'new-project-name',
    placeholder: 'my-project',
    'aria-label': 'Project name',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  const parentInput = el('input', {
    type: 'text',
    class: 'new-project-parent',
    placeholder: '~/Projects',
    'aria-label': 'Parent directory',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  parentInput.value = defaultParentDir
  const browseBtn = el('button', { type: 'button', class: 'new-project-browse' }, 'Browse…')
  const pathPreview = el('p', { class: 'field-hint new-project-path-preview' })
  const error = el('p', { class: 'new-project-error field-hint', hidden: true })
  const okBtn = el('button', { type: 'button', class: 'ui-btn ui-btn-primary' }, 'Create')
  const cancelBtn = el('button', { type: 'button', class: 'ui-btn' }, 'Cancel')

  function updatePathPreview(): void {
    const name = nameInput.value.trim()
    const parent = parentInput.value.trim()
    pathPreview.textContent = name && parent ? `${parent}/${name}` : ''
  }

  function renderError(message: string): void {
    error.textContent = message
    error.hidden = false
  }

  nameInput.addEventListener('input', updatePathPreview)
  parentInput.addEventListener('input', updatePathPreview)

  browseBtn.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const picked = await api.workspace.pickParentDirectory()
      if (picked) parentInput.value = picked
      updatePathPreview()
    })()
  })

  dialog.append(
    el('h3', {}, 'New project'),
    el(
      'p',
      { class: 'field-hint' },
      'Create a folder with a starter AGENT.md and README.md, then git init it.',
    ),
    el('label', { class: 'new-project-field' }, 'Name ', nameInput),
    el(
      'label',
      { class: 'new-project-field' },
      'Parent directory ',
      el('div', { class: 'new-project-parent-row' }, parentInput, browseBtn),
    ),
    pathPreview,
    error,
    el('div', { class: 'new-project-actions' }, cancelBtn, okBtn),
  )

  return new Promise((resolve) => {
    let settled = false
    // The <dialog> element is a module-level singleton reused across opens, so
    // listeners bound to it (rather than to the per-open children) would stack
    // up on every call. Tie them to this open and drop them when it settles.
    const perOpen = new AbortController()
    const finish = (value: NewProjectPick | null): void => {
      if (settled) return
      settled = true
      perOpen.abort()
      dialog.close()
      resolve(value)
    }

    dialog.addEventListener(
      'cancel',
      () => {
        finish(null)
      },
      { signal: perOpen.signal },
    )
    cancelBtn.addEventListener('click', () => {
      finish(null)
    })

    okBtn.addEventListener('click', () => {
      const name = nameInput.value.trim()
      const parentDir = parentInput.value.trim()
      if (!name) {
        renderError('Enter a project name.')
        return
      }
      if (!parentDir) {
        renderError('Choose a parent directory.')
        return
      }
      finish({ name, parentDir })
    })

    // Enter in the name field submits (unless it would be a lone Enter on a
    // browse-focused state — browsers already gate native form submits).
    dialog.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter' && e.target === nameInput) {
          e.preventDefault()
          okBtn.click()
        }
      },
      { signal: perOpen.signal },
    )

    dialog.showModal()
    nameInput.focus()
  })
}
