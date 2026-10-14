import type { SettingsSnapshot } from '@shared/settings-contract.ts'
import { escapeHtml } from '@copse/streaming-markdown'
import { errorMessage } from '@shared/errors.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { el } from '../../dom/helpers.ts'
import { uiField } from '../../ui/index.ts'

export interface GhCliSection {
  root: HTMLElement
  refreshStatus: (signal?: AbortSignal) => Promise<void>
  load: (snapshot: SettingsSnapshot) => void
}

const BACKEND_OPTIONS: Array<{ value: 'auto' | 'cli' | 'api'; label: string }> = [
  { value: 'auto', label: 'Automatic (gh CLI, then API)' },
  { value: 'cli', label: 'GitHub CLI (gh)' },
  { value: 'api', label: 'GitHub API (token)' },
]

export function createGhCliSection(
  api: ApiClient,
  options: { deferOrdinaryWrites?: boolean } = {},
): GhCliSection {
  const statusEl = el('div', { class: 'setup-detection-status gh-cli-status' })

  const backendSelect = el('select', {
    name: 'githubBackend',
    'aria-label': 'GitHub backend',
  })
  for (const option of BACKEND_OPTIONS) {
    backendSelect.append(el('option', { value: option.value }, option.label))
  }
  if (!options.deferOrdinaryWrites)
    void api.settings.get('githubBackend').then((value) => {
      backendSelect.value = value === 'cli' || value === 'api' ? value : 'auto'
    })
  backendSelect.addEventListener('change', () => {
    if (!options.deferOrdinaryWrites) void api.settings.set('githubBackend', backendSelect.value)
  })
  const backendField = uiField({
    label: 'Backend',
    control: backendSelect,
    className: 'gh-backend-field',
  })

  async function refreshStatus(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    statusEl.textContent = 'Checking GitHub CLI…'
    try {
      const status = await api.gh.status()
      if (signal?.aborted) return
      if (!status.installed) {
        statusEl.innerHTML =
          '<strong>Not installed.</strong> Install <a href="https://cli.github.com/" target="_blank" rel="noopener noreferrer">GitHub CLI</a> to browse pull requests and use PR tools in chat.'
        return
      }
      if (!status.authenticated) {
        statusEl.innerHTML =
          '<strong>Installed, not signed in.</strong> Run <code>gh auth login</code> in a terminal to connect your GitHub account.'
        return
      }
      // `gh api user` stdout is external data — escape before it reaches innerHTML.
      const user = status.username ? `@${escapeHtml(status.username)}` : 'your GitHub account'
      statusEl.innerHTML = `<strong>Ready.</strong> Signed in as ${user}. Pull request links in chat open in the PRs panel.`
    } catch (err) {
      if (signal?.aborted) return
      statusEl.textContent = errorMessage(err)
    }
  }

  const root = el(
    'fieldset',
    {},
    el('legend', {}, 'GitHub CLI'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Copse uses the local ',
      el('code', {}, 'gh'),
      ' command when it is available to list your pull requests, show diffs, and power agent PR tools. Without it, PR links still open in the in-app browser.',
    ),
    statusEl,
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Choose how Copse reaches GitHub. ',
      el('strong', {}, 'Automatic'),
      ' uses the ',
      el('code', {}, 'gh'),
      ' CLI when it is signed in, otherwise the GitHub REST/GraphQL API with a ',
      el('code', {}, 'GITHUB_TOKEN'),
      ' or ',
      el('code', {}, 'gh auth token'),
      '.',
    ),
    backendField,
  )

  return {
    root,
    refreshStatus,
    load: (snapshot): void => {
      backendSelect.value = snapshot.githubBackend ?? 'auto'
    },
  }
}
