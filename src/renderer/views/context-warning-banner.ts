// A persistent, dismissible banner shown at startup when no available chat model
// has a usable context window (see chat-default-context.ts). Local servers (LM
// Studio et al.) reload models at a tiny default context after a reboot, so a
// local-only setup can silently over-trim every agent run. The banner links to
// the Local models settings section, where the LM Studio advisory in turn links
// to the "make it restart-proof" guide.

import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { noDecentChatDefaultAdvice } from '@shared/context-window-advice.ts'
import {
  isSettingsDialogOpen,
  onSettingsDialogClose,
  openSettingsDialog,
} from './settings-dialog.ts'

const BANNER_ID = 'context-warning-banner'

export interface ContextWarningBanner {
  /** Re-check chat-default context health and show/hide the banner accordingly. */
  refresh: () => Promise<void>
}

export function mountContextWarningBanner(api: ApiClient): ContextWarningBanner {
  let host: HTMLElement | null = null
  // Once the user dismisses it we don't re-show it this session, even if a later
  // re-check still finds the setup low — one nudge per launch is enough.
  let dismissed = false

  function remove(): void {
    host?.remove()
    host = null
  }

  function render(message: string): void {
    remove()
    const openBtn = el(
      'button',
      { type: 'button', class: 'context-warning-action' },
      'Open settings',
    )
    openBtn.addEventListener('click', () => {
      // "…not if we're already there": only offer to open settings when it's closed.
      if (!isSettingsDialogOpen()) openSettingsDialog('local-models')
    })
    const closeBtn = el(
      'button',
      { type: 'button', class: 'context-warning-dismiss', 'aria-label': 'Dismiss' },
      '✕',
    )
    closeBtn.addEventListener('click', () => {
      dismissed = true
      remove()
    })
    host = el(
      'div',
      { id: BANNER_ID, class: 'context-warning-banner', role: 'status' },
      el('span', { class: 'context-warning-icon', 'aria-hidden': 'true' }, '⚠'),
      el('span', { class: 'context-warning-text' }, message),
      el('span', { class: 'context-warning-actions' }, openBtn, closeBtn),
    )
    // Sit in normal flow just below the titlebar so it pushes the app down rather
    // than overlaying (and intercepting clicks on) the titlebar controls.
    const titlebar = document.getElementById('titlebar')
    if (titlebar?.parentElement) titlebar.after(host)
    else (document.getElementById('app') ?? document.body).prepend(host)
  }

  async function refresh(): Promise<void> {
    if (dismissed) return
    let health: Awaited<ReturnType<ApiClient['models']['chatDefaultContextHealth']>>
    try {
      health = await api.models.chatDefaultContextHealth()
    } catch {
      // Never let a warning check block startup; stay silent if it fails.
      return
    }
    if (health.hasDecentChatDefault) {
      remove()
      return
    }
    render(noDecentChatDefaultAdvice(health.bestAvailableContext, health.minimum))
  }

  // The user may fix the context length in settings; re-check when it closes so
  // the banner clears itself without a restart.
  onSettingsDialogClose(() => {
    void refresh()
  })

  return { refresh }
}
