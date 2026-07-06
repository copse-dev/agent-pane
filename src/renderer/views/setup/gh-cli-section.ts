import { escapeHtml } from '@copse/streaming-markdown'
import { errorMessage } from '@shared/errors.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { el } from '../../dom/helpers.ts'

export interface GhCliSection {
  root: HTMLElement
  refreshStatus: () => Promise<void>
}

export function createGhCliSection(api: ApiClient): GhCliSection {
  const statusEl = el('div', { class: 'setup-detection-status gh-cli-status' })

  async function refreshStatus(): Promise<void> {
    statusEl.textContent = 'Checking GitHub CLI…'
    try {
      const status = await api.gh.status()
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
  )

  return { root, refreshStatus }
}
