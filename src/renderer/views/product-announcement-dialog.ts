import type { ApiClient } from '../../preload/api.d.ts'
import {
  ANNOUNCEMENT_HISTORY_SETTING,
  parseAnnouncementHistory,
} from '@shared/product-announcements.ts'
import type { ProductAnnouncement } from '../product-announcements.ts'
import type { SettingsSection } from './settings-dialog.ts'
import { el } from '../dom/helpers.ts'
import { uiActions } from '../ui/index.ts'

/**
 * One at a time, after any existing modal (including first-run onboarding).
 * New profiles silently baseline the current catalog. Existing profiles save
 * history only after explicit dismissal; interrupted announcements
 * remain eligible on the next launch. Copy is plain text, never HTML.
 */
export async function mountProductAnnouncements(
  settings: Pick<ApiClient['settings'], 'get' | 'set'>,
  announcements: readonly ProductAnnouncement[],
  openSettings: (section: SettingsSection) => void,
  isNewUser: boolean,
): Promise<() => void> {
  if (announcements.length === 0 && !isNewUser) return () => {}
  const seen = new Set(parseAnnouncementHistory(await settings.get(ANNOUNCEMENT_HISTORY_SETTING)))
  const unique = new Map(announcements.map((entry) => [entry.id, entry]))
  if (isNewUser) {
    await settings.set(ANNOUNCEMENT_HISTORY_SETTING, [...new Set([...seen, ...unique.keys()])])
    return () => {}
  }
  const pending = [...unique.values()].filter((entry) => !seen.has(entry.id))
  if (pending.length === 0) return () => {}

  const title = el('h2', { id: 'product-announcement-title' })
  const message = el('p', { id: 'product-announcement-message' })
  const detail = el('p', { class: 'product-announcement-detail' })
  const progress = el('span', { class: 'product-announcement-progress' })
  const error = el('p', { class: 'product-announcement-error', role: 'alert', hidden: true })
  const settingsButton = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' })
  const dismissButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary', autofocus: true },
    'Got it',
  )
  const actions = uiActions(settingsButton, dismissButton, {
    className: 'product-announcement-actions',
  })
  const dialog = el(
    'dialog',
    {
      id: 'product-announcement-dialog',
      'aria-labelledby': title.id,
      'aria-describedby': message.id,
    },
    el('div', { class: 'product-announcement-meta' }, el('span', {}, 'New in Copse'), progress),
    title,
    message,
    detail,
    error,
    actions,
  )
  document.body.append(dialog)
  let active: ProductAnnouncement | undefined
  let saving = false
  let disposed = false
  let escapeHeld = false
  let presentationTimer: number | undefined
  let completed = 0
  const total = pending.length

  function isDisposed(): boolean {
    return disposed
  }

  function renderNext(): void {
    if (isDisposed() || active || saving || escapeHeld || document.querySelector('dialog[open]'))
      return
    active = pending.shift()
    if (!active) {
      dispose()
      return
    }
    dialog.dataset['announcementId'] = active.id
    title.textContent = active.title
    message.textContent = active.message
    detail.textContent = active.detail ?? ''
    detail.hidden = !active.detail
    progress.textContent = total > 1 ? `${String(completed + 1)} of ${String(total)}` : ''
    settingsButton.hidden = !active.settingsAction
    settingsButton.textContent = active.settingsAction?.label ?? ''
    error.hidden = true
    dialog.showModal()
    dismissButton.focus()
  }

  async function acknowledge(navigate: boolean): Promise<void> {
    if (!active || saving || isDisposed()) return
    const entry = active
    saving = true
    settingsButton.disabled = true
    dismissButton.disabled = true
    error.hidden = true
    try {
      // Re-read before each write so acknowledgements from another window are
      // preserved rather than overwritten by this window's startup snapshot.
      const latest = parseAnnouncementHistory(await settings.get(ANNOUNCEMENT_HISTORY_SETTING))
      const next = [...new Set([...latest, ...seen, entry.id])]
      await settings.set(ANNOUNCEMENT_HISTORY_SETTING, next)
      if (isDisposed()) return
      for (const id of next) seen.add(id)
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const candidate = pending[index]
        if (candidate && seen.has(candidate.id)) pending.splice(index, 1)
      }
      active = undefined
      completed += 1
      dialog.close()
      if (navigate && entry.settingsAction) openSettings(entry.settingsAction.section)
    } catch {
      if (!isDisposed()) {
        error.textContent = 'Could not save your acknowledgement. Please try again.'
        error.hidden = false
      }
    } finally {
      saving = false
      settingsButton.disabled = false
      dismissButton.disabled = false
      if (!isDisposed()) {
        if (active) dismissButton.focus()
        else renderNext()
      }
    }
  }

  dismissButton.addEventListener('click', () => {
    void acknowledge(false)
  })
  settingsButton.addEventListener('click', () => {
    void acknowledge(true)
  })
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    void acknowledge(false)
  })
  // Onboarding, Settings, and other native dialogs all change their `open`
  // attribute. Observe only that and node insertion/removal, without polling.
  function scheduleNext(): void {
    if (presentationTimer !== undefined || isDisposed()) return
    presentationTimer = window.setTimeout(() => {
      presentationTimer = undefined
      renderNext()
    }, 0)
  }
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') escapeHeld = true
  }
  function onKeyUp(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    releaseEscape()
  }
  function releaseEscape(): void {
    escapeHeld = false
    // A native dialog may close during Escape's default action. Opening the
    // next one inside that action lets the same key dismiss it too. Wait until
    // release and a new task before presenting another announcement.
    scheduleNext()
  }
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', releaseEscape)
  const observer = new MutationObserver(scheduleNext)
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['open'],
    childList: true,
    subtree: true,
  })

  function dispose(): void {
    disposed = true
    observer.disconnect()
    if (presentationTimer !== undefined) window.clearTimeout(presentationTimer)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('blur', releaseEscape)
    if (dialog.open) dialog.close()
    dialog.remove()
  }

  renderNext()
  return dispose
}
