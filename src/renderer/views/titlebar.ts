import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openSettingsDialog } from './settings-dialog.ts'

function basename(p: string) {
  return p.split('/').pop() ?? p
}

export function mountTitlebar(root: HTMLElement, store: AppStore, _api: ApiClient): () => void {
  // The structural #titlebar div needs the .titlebar class for its flex layout,
  // height, and traffic-light clearance to apply. Without it the controls
  // collapse and hide under the macOS window buttons.
  root.classList.add('titlebar')

  const dragRegion = el('div', { class: 'titlebar-drag' })
  const workspaceName = el('span', { class: 'workspace-name' }, 'No folder')
  // Opening projects lives in the projects panel; the titlebar only toggles the
  // file explorer and opens settings.
  const filesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Toggle file explorer' },
    '🗂 Files',
  )
  const settingsBtn = el('button', { class: 'titlebar-btn', 'aria-label': 'Settings' }, '⚙')

  root.append(dragRegion, workspaceName, filesBtn, settingsBtn)

  filesBtn.addEventListener('click', () => {
    store.setState({ filesPaneOpen: !store.getState().filesPaneOpen })
    store.emit('files_pane_changed')
    syncFilesBtn()
  })

  function syncFilesBtn() {
    filesBtn.classList.toggle('active', store.getState().filesPaneOpen)
  }

  function syncName() {
    const r = store.getState().workspaceRoot
    workspaceName.textContent = r ? basename(r) : 'No folder'
  }
  // Set state immediately — the titlebar is mounted in response to
  // workspace_changed, so it would otherwise miss that initial event.
  syncName()
  syncFilesBtn()
  const unsubs = [
    store.on('workspace_changed', syncName),
    store.on('files_pane_changed', syncFilesBtn),
  ]

  settingsBtn.addEventListener('click', () => {
    openSettingsDialog()
  })

  return () => unsubs.forEach((u) => u())
}
