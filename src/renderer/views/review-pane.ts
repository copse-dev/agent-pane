import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitDiffMonaco } from '../monaco/git-diff-viewer.ts'
import { el, qsRequired } from '../dom/helpers.ts'
import { sameItems } from '@shared/store/store.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'
import { openRightPanel, selectRightPanel } from '../controller/panels.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { mountPrPane } from './pr-pane.ts'

/** One review destination; the old modes remain the local/remote subject identity
 * for deep links, detached windows and retained editor selections. */
export function mountReviewPane(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  monaco: GitDiffMonaco,
): () => void {
  const localList = qsRequired(root, '#git-changes-host')
  const localViewer = qsRequired(root, '#git-diff-viewer-host')
  const prList = qsRequired(root, '#pr-list-host')
  const prViewer = qsRequired(root, '#pr-viewer-host')
  const destroyLocal = mountGitChangesPane(localList, localViewer, store, api, monaco)
  const destroyPr = mountPrPane(prList, prViewer, store, api, monaco)

  const label = el('span', { class: 'review-subject-label pane-header-title' })
  const picker = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost ui-btn-compact review-subject-picker',
      'aria-label': 'Choose change to review',
      'aria-expanded': 'false',
      'aria-controls': 'review-subject-choices',
      'aria-haspopup': 'dialog',
    },
    label,
    chevronDownIcon('ui-icon ui-icon-sm'),
  )
  const localChoice = el(
    'button',
    { type: 'button', class: 'review-local-choice git-change-row' },
    'Local changes',
  )
  const choices = el('div', {
    id: 'review-subject-choices',
    class: 'review-subject-choices',
    popover: 'auto',
    role: 'dialog',
    'aria-label': 'Changes and pull requests',
  })
  const prListParent = prList.parentElement
  const prListNext = prList.nextSibling
  choices.append(localChoice, prList)
  const localTools = qsRequired(localList, '.pane-header')
  const prTools = qsRequired(prList, '.pane-header')
  localTools.classList.add('review-tools')
  prTools.classList.add('review-tools')
  const header = el('div', { class: 'review-header' }, picker, localTools, prTools)
  const filesHeading = el('div', { class: 'review-files-heading' }, 'Files changed')
  localList.prepend(filesHeading)
  const title = el('h4', { class: 'review-local-title' })
  const location = el('div', { class: 'pr-viewer-subtitle' })
  const localMeta = el('div', { class: 'review-local-meta' }, title, location)
  localViewer.prepend(localMeta)
  root.prepend(header, choices)

  function closeChoices(): void {
    if (choices.matches(':popover-open')) choices.hidePopover()
  }
  picker.addEventListener('click', () => {
    const rect = picker.getBoundingClientRect()
    const width = Math.min(360, root.clientWidth - 16, window.innerWidth - 16)
    choices.style.width = `${String(width)}px`
    choices.style.top = `${String(rect.bottom)}px`
    choices.style.left = `${String(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`
    choices.style.maxHeight = `${String(Math.max(100, window.innerHeight - rect.bottom - 8))}px`
    choices.togglePopover()
  })
  choices.addEventListener('toggle', () => {
    const open = choices.matches(':popover-open')
    picker.setAttribute('aria-expanded', String(open))
    if (open) localChoice.focus()
  })
  choices.addEventListener('keydown', (event) => {
    // The PR filter owns Escape while clearing a query; an empty filter lets
    // Escape dismiss this native popover and return focus to its trigger.
    if (event.key !== 'Escape' || event.defaultPrevented) return
    closeChoices()
    picker.focus()
  })
  localChoice.addEventListener('click', () => {
    openRightPanel(store, 'changes')
    closeChoices()
    picker.focus()
  })
  const onPrChoice = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || !event.target.closest('.pr-list-row')) return
    openRightPanel(store, 'prs')
    closeChoices()
    picker.focus()
  }
  prList.addEventListener('click', onPrChoice)

  function sync(): void {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    const local = rightPanelMode === 'changes'
    const reviewing = local || rightPanelMode === 'prs'
    header.hidden = !reviewing
    root.classList.toggle('is-review-pane', reviewing)
    localTools.hidden = !local
    prTools.hidden = local
    label.textContent = local ? 'Local changes' : 'Pull request'
    localChoice.setAttribute('aria-current', String(local))
    // Both subjects live in the picker, even while the local diff is selected.
    prList.hidden = false
    if (!filesPaneOpen || !reviewing) closeChoices()
  }
  function syncLocalSubject(): void {
    const thread = getActiveThread(store)
    title.textContent = thread?.title.trim() ? thread.title : 'Local changes'
    const branch = thread?.worktree?.branch ?? thread?.gitBranch
    location.textContent = branch ? `${branch} · Only on this machine` : 'Only on this machine'
  }
  syncLocalSubject()
  sync()
  const unsub = selectRightPanel(store, sync)
  const unsubSubject = store.select(
    (state) => {
      const thread = getActiveThread(store)
      return [
        state.activeProjectId,
        state.activeThreadId,
        thread?.title,
        thread?.worktree?.branch,
        thread?.gitBranch,
      ] as const
    },
    syncLocalSubject,
    sameItems,
  )
  return () => {
    unsub()
    unsubSubject()
    destroyPr()
    destroyLocal()
    prList.removeEventListener('click', onPrChoice)
    localTools.classList.remove('review-tools')
    prTools.classList.remove('review-tools')
    localList.prepend(localTools)
    prList.prepend(prTools)
    prListParent?.insertBefore(prList, prListNext)
    closeChoices()
    header.remove()
    choices.remove()
    filesHeading.remove()
    localMeta.remove()
    root.classList.remove('is-review-pane')
  }
}
