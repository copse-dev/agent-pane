import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { addProject } from '../controller/projects.ts'

export function mountWelcome(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const heading = el('h1', { class: 'welcome-heading' }, 'Copse')
  const sub = el('p', { class: 'welcome-sub' }, 'No project open.')
  const openBtn = el('button', { class: 'welcome-open-btn' }, 'Open Folder')
  const keyHint = el(
    'p',
    { class: 'welcome-hint' },
    'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings, or configure LM Studio, to connect to a model.',
  )
  const agentHint = el(
    'p',
    { class: 'welcome-hint' },
    'Add AGENT.md to your workspace root to give the agent project-specific context.',
  )

  const card = el('div', { class: 'welcome-card' }, heading, sub, openBtn, keyHint, agentHint)
  root.append(card)
  root.classList.add('visible')

  openBtn.addEventListener('click', () => {
    void addProject(store, api)
  })

  return () => {
    root.classList.remove('visible')
    card.remove()
  }
}
