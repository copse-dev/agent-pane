import { el, clear, on } from '../dom/helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import { showToast } from './toast.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ExternalEditor } from '@shared/types/editors.ts'

function editorIcon(): SVGSVGElement {
  // A generic "code window" glyph — the dropdown lists editors by name, so the
  // trigger stays brand-neutral rather than trying to draw each editor's logo.
  return outlineIcon(
    'open-in-editor',
    [
      'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
      'm8 9-3 3 3 3',
      'm13 15 3-3-3-3',
    ],
    'titlebar-btn-icon',
  )
}

/**
 * Titlebar "Open in editor" control, modelled on Codex's split dropdown: the
 * primary button hands the current workspace to the default editor (the one you
 * used last, else the first detected), while the chevron opens the full list of
 * installed editors. The whole control hides when no editor is detected or no
 * folder is open — there is nothing to open in that case.
 */
export function mountOpenInEditor(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
): { element: HTMLElement; destroy: () => void } {
  const wrap = el('div', { class: 'open-in-editor', hidden: true })
  const primary = el(
    'button',
    {
      type: 'button',
      class: 'titlebar-text-btn open-in-editor-primary',
      'aria-label': 'Open workspace in editor',
    },
    editorIcon(),
    el('span', { class: 'open-in-editor-label' }, 'Open in'),
  )
  const caret = el(
    'button',
    {
      type: 'button',
      class: 'titlebar-text-btn open-in-editor-caret',
      'aria-label': 'Choose editor',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    },
    chevronDownIcon('ui-icon ui-icon-sm'),
  )
  const menu = el('div', { class: 'open-in-editor-menu', role: 'menu', hidden: '' })
  // A transparent full-window backdrop is the only reliable way to dismiss the
  // menu: the titlebar's empty space is a `-webkit-app-region: drag` region, so
  // the OS consumes clicks there for window-move and no DOM click reaches a
  // document listener. The backdrop (no-drag, painted within the titlebar's
  // stacking context above the buttons but below the menu) catches those clicks.
  const backdrop = el('div', { class: 'open-in-editor-backdrop', hidden: '' })
  wrap.append(primary, caret, menu, backdrop)
  root.append(wrap)

  let editors: ExternalEditor[] = []
  let defaultId: string | null = null
  let open = false
  const cleanups: Array<() => void> = []

  function defaultEditor(): ExternalEditor | null {
    if (editors.length === 0) return null
    return editors.find((e) => e.id === defaultId) ?? editors[0] ?? null
  }

  function setOpen(next: boolean): void {
    // A single detected editor needs no menu — the primary button is enough.
    open = next && editors.length > 1
    caret.setAttribute('aria-expanded', String(open))
    if (open) {
      menu.removeAttribute('hidden')
      backdrop.removeAttribute('hidden')
    } else {
      menu.setAttribute('hidden', '')
      backdrop.setAttribute('hidden', '')
    }
  }

  function launch(editorId: string): void {
    setOpen(false)
    void api.editors.open(editorId).then(
      () => {
        // Optimistically make the launched editor the sticky default so the
        // next primary click reuses it, without waiting for a fresh list scan.
        defaultId = editorId
        syncTrigger()
      },
      (err: unknown) => {
        const name = editors.find((e) => e.id === editorId)?.name ?? 'editor'
        showToast(`Couldn't open ${name}: ${err instanceof Error ? err.message : String(err)}`, {
          variant: 'error',
        })
      },
    )
  }

  function syncTrigger(): void {
    const def = defaultEditor()
    const labelEl = primary.querySelector('.open-in-editor-label')
    if (labelEl) labelEl.textContent = def ? `Open in ${def.name}` : 'Open in'
    if (def) primary.title = `Open this folder in ${def.name}`
    // The caret only earns its place when there's a choice to make.
    caret.hidden = editors.length < 2
  }

  function renderMenu(): void {
    clear(menu)
    for (const editor of editors) {
      const item = el(
        'button',
        {
          type: 'button',
          class: 'open-in-editor-option',
          role: 'menuitem',
          'data-editor-id': editor.id,
        },
        `Open in ${editor.name}`,
      )
      if (editor.id === defaultEditor()?.id) item.classList.add('is-default')
      item.addEventListener('click', () => {
        launch(editor.id)
      })
      menu.append(item)
    }
  }

  function syncVisibility(): void {
    const hasFolder = store.getState().workspaceRoot !== null
    const project = store.getState().projects.find((p) => p.id === store.getState().activeProjectId)
    const isRemote = !!project?.sshHost
    const hasRemoteCapable = editors.some((e) => e.id === 'vscode' || e.id === 'cursor')
    wrap.hidden = editors.length === 0 || !hasFolder || (isRemote && !hasRemoteCapable)
    if (wrap.hidden) setOpen(false)
  }

  async function refresh(): Promise<void> {
    try {
      const list = await api.editors.list()
      editors = list.editors
      defaultId = list.lastUsedId
    } catch {
      editors = []
      defaultId = null
    }
    renderMenu()
    syncTrigger()
    syncVisibility()
  }

  primary.addEventListener('click', () => {
    const def = defaultEditor()
    if (def) launch(def.id)
  })
  caret.addEventListener('click', () => {
    setOpen(!open)
  })
  backdrop.addEventListener('click', () => {
    setOpen(false)
  })

  cleanups.push(
    // Fallback for clicks the backdrop doesn't cover (e.g. inside a webview
    // pane); the backdrop handles the titlebar's drag region, which this can't.
    on(document, 'click', (e) => {
      if (open && !wrap.contains(e.target as Node)) setOpen(false)
    }),
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && open) setOpen(false)
    }),
    store.on('workspace_changed', syncVisibility),
    store.on('projects_changed', syncVisibility),
  )

  void refresh()

  return {
    element: wrap,
    destroy: (): void => {
      cleanups.forEach((u) => {
        u()
      })
    },
  }
}
