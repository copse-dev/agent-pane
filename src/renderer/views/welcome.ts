import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { addProject, addRemoteProject } from '../controller/projects.ts'
import { isSshWorkspaceEnabled } from '../controller/ssh-workspace-ui.ts'

export function mountWelcome(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const heading = el('h1', { class: 'welcome-heading' }, 'Copse')
  const sub = el('p', { class: 'welcome-sub' }, 'No project open.')
  const openBtn = el('button', { class: 'welcome-open-btn' }, 'Open Folder')
  const openRemoteBtn = el(
    'button',
    { class: 'welcome-open-btn welcome-open-remote-btn' },
    'Open Remote Folder',
  )
  const keyHint = el(
    'p',
    { class: 'welcome-hint' },
    'Configure cloud API keys and local models in Settings, or complete the setup guide when Copse opens.',
  )
  const agentHint = el(
    'p',
    { class: 'welcome-hint' },
    'Add AGENT.md, AGENTS.md, or CLAUDE.md to your workspace root to give the agent project-specific context.',
  )

  const card = el(
    'div',
    { class: 'welcome-card' },
    heading,
    sub,
    openBtn,
    openRemoteBtn,
    keyHint,
    agentHint,
  )
  root.append(card)
  root.classList.add('visible')

  openBtn.addEventListener('click', () => {
    void addProject(store, api)
  })

  openRemoteBtn.addEventListener('click', () => {
    void addRemoteProject(store, api)
  })

  const syncRemoteOpenVisibility = (): void => {
    void isSshWorkspaceEnabled(api).then((enabled) => {
      openRemoteBtn.hidden = !enabled
    })
  }
  syncRemoteOpenVisibility()
  store.on('settings_changed', syncRemoteOpenVisibility)

  return () => {
    root.classList.remove('visible')
    card.remove()
  }
}
