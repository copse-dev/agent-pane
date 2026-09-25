import { renderMarkdown } from '@copse/streaming-markdown'
import { el, qs } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { uiActions } from '../ui/index.ts'
import { showToast } from './toast.ts'

interface UpdatePromptRequest {
  id: string
  message: string
  detail?: string
  changelog?: { version: string; notes: string }[]
  changelogUrl?: string
  buttons: string[]
  defaultIndex?: number
  cancelIndex?: number
}

/**
 * In-app prompts for auto-update download/install consent. Replaces Electron's
 * native `dialog.showMessageBox`, which looked out of place in the Copse UI.
 */
export function mountUpdatePromptDialog(api: ApiClient): void {
  const messageEl = el('h3', { class: 'update-prompt-message' })
  const detailEl = el('p', { class: 'update-prompt-detail' })
  const changelogEl = el('section', { class: 'update-prompt-changelog' })
  const buttonsEl = uiActions({ className: 'update-prompt-buttons' })
  const dialog = el(
    'dialog',
    { id: 'update-prompt-dialog' },
    messageEl,
    detailEl,
    changelogEl,
    buttonsEl,
  )
  document.body.append(dialog)

  const queue: UpdatePromptRequest[] = []
  let active: UpdatePromptRequest | null = null

  function finish(buttonIndex: number): void {
    if (!active) return
    const id = active.id
    active = null
    dialog.close()
    void api.updatePrompt.respond(id, buttonIndex)
    if (queue.length > 0) {
      active = queue.shift() ?? null
      renderActive()
    }
  }

  function renderActive(): void {
    if (!active) return
    messageEl.textContent = active.message
    if (active.detail) {
      detailEl.textContent = active.detail
      detailEl.hidden = false
    } else {
      detailEl.textContent = ''
      detailEl.hidden = true
    }
    renderChangelog(changelogEl, active)
    dialog.classList.toggle('has-changelog', !changelogEl.hidden)

    const defaultIndex = active.defaultIndex ?? 0
    buttonsEl.replaceChildren(
      ...active.buttons.map((label, index) => {
        const isPrimary = index === defaultIndex
        const button = el(
          'button',
          {
            type: 'button',
            class: isPrimary
              ? 'ui-btn ui-btn-primary update-prompt-primary'
              : 'ui-btn ui-btn-secondary update-prompt-secondary',
          },
          label,
        )
        button.addEventListener('click', () => {
          finish(index)
        })
        return button
      }),
    )

    dialog.showModal()
    qs<HTMLButtonElement>(buttonsEl, '.update-prompt-primary')?.focus()
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    finish(active?.cancelIndex ?? (active ? active.buttons.length - 1 : -1))
  })

  api.updatePrompt.onRequest((req) => {
    if (active) queue.push(req)
    else {
      active = req
      renderActive()
    }
  })

  api.updatePrompt.onDevNotice(() => {
    showToast(
      'Updates apply to the packaged app — automatic updates are available in the signed, downloaded build of Copse.',
      { variant: 'info' },
    )
  })
}

/**
 * Every version the update brings, newest first, so a user who skipped
 * releases sees what each one changed. Notes are Markdown from the public
 * release repository and go through the same sanitizing renderer as PR bodies.
 */
function renderChangelog(host: HTMLElement, req: UpdatePromptRequest): void {
  const entries = req.changelog ?? []
  if (entries.length === 0) {
    host.replaceChildren()
    host.hidden = true
    return
  }
  const heading =
    entries.length === 1 ? "What's new" : `What's new in ${String(entries.length)} releases`
  const list = el('div', { class: 'update-prompt-changelog-list' })
  for (const entry of entries) {
    const notes = el('div', { class: 'update-prompt-notes message-text streaming-markdown' })
    notes.innerHTML = renderMarkdown(entry.notes || '_No notes for this release._')
    list.append(
      el(
        'article',
        { class: 'update-prompt-release', 'data-version': entry.version },
        el('h4', { class: 'update-prompt-version' }, entry.version),
        notes,
      ),
    )
  }
  const children: HTMLElement[] = [
    el('h4', { class: 'update-prompt-changelog-title' }, heading),
    list,
  ]
  if (req.changelogUrl?.startsWith('https://') === true) {
    // Opens in the system browser: the window-open handler never navigates the app.
    children.push(
      el(
        'a',
        {
          class: 'update-prompt-all-notes',
          href: req.changelogUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'All release notes',
      ),
    )
  }
  host.replaceChildren(...children)
  host.hidden = false
}
