import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { roadmapThreadIds } from '@shared/roadmap/note.ts'
import { getThreadById, switchThread } from '@shared/store/thread-helpers.ts'
import { planCriteria, type StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import { el } from '../dom/helpers.ts'

function planSummary(plan: StoredThreadPlan): string {
  if (plan.meta.status !== 'approved')
    return `${plan.meta.status} · revision ${String(plan.meta.currentRevision)}`
  const criteria = planCriteria(plan.body)
  const counts = { met: 0, partial: 0, unverified: 0 }
  for (const criterion of criteria) {
    const result = plan.completion?.results.find((row) => row.criterionId === criterion.id)
    counts[result?.status ?? 'unverified']++
  }
  return `Approved r${String(plan.meta.approvedRevision)} · ${Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${String(count)} ${status}`)
    .join(' · ')}`
}

/** Read plans from their owning task, never mirror mutable plan bodies into notes. */
export function mountRoadmapAttempts(
  api: ApiClient,
  store: AppStore,
): {
  element: HTMLElement
  show: (fields: Readonly<Record<string, string>>) => void
  destroy: () => void
} {
  const element = el('section', {
    class: 'roadmap-attempts',
    'aria-label': 'Linked work',
    hidden: true,
  })
  let fields: Readonly<Record<string, string>> = {}
  let key = ''
  let generation = 0
  function show(next: Readonly<Record<string, string>>, force = false): void {
    fields = next
    const projectId = store.getState().activeProjectId
    const ids = roadmapThreadIds(fields)
    const nextKey = JSON.stringify([projectId, ids, ids.map((id) => !!getThreadById(store, id))])
    if (!force && nextKey === key) return
    key = nextKey
    const token = ++generation
    element.replaceChildren()
    element.hidden = ids.length === 0
    if (!projectId || ids.length === 0) return
    element.append(el('h4', {}, 'Linked work'))
    const older = el(
      'details',
      { class: 'roadmap-previous-attempts' },
      el('summary', {}, `Earlier attempts (${String(ids.length - 1)})`),
    )
    for (const [index, threadId] of ids.entries()) {
      const thread = getThreadById(store, threadId)
      const name = el(
        'span',
        { class: 'roadmap-attempt-title' },
        thread?.title ?? 'Task unavailable',
      )
      const summary = el('span', { class: 'roadmap-attempt-summary' }, 'Loading plan…')
      const open = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact' },
        'Open task',
      )
      open.disabled = !thread
      const row = el('div', { class: 'roadmap-attempt' }, el('div', {}, name, summary), open)
      if (index === 0) element.append(row)
      else older.append(row)
      let hasPlan = false
      open.addEventListener('click', () => {
        if (!getThreadById(store, threadId)) return
        store.emit('composer_draft_flush')
        switchThread(store, threadId)
        if (hasPlan) store.emit('thread_plan_open')
      })
      void api.plans
        .get(projectId, threadId)
        .then((plan) => {
          if (token !== generation) return
          hasPlan = !!plan
          name.textContent = plan?.meta.title ?? thread?.title ?? 'Task unavailable'
          summary.textContent = plan ? planSummary(plan) : 'Implementation task'
          if (plan) {
            open.textContent = plan.meta.status === 'approved' ? 'View evidence' : 'Open plan'
            summary.title =
              'Completion results are reported by the agent; roadmap status is unchanged.'
          }
        })
        .catch(() => {
          if (token === generation) summary.textContent = 'Plan unavailable'
        })
    }
    if (ids.length > 1) element.append(older)
  }
  const unsubs = [
    store.on('thread_plan_changed', (threadId) => {
      if (roadmapThreadIds(fields).includes(threadId)) show(fields, true)
    }),
    store.on('thread_status_changed', (threadId, status) => {
      if (status !== 'running' && roadmapThreadIds(fields).includes(threadId)) show(fields, true)
    }),
  ]
  return {
    element,
    show,
    destroy: (): void => {
      generation++
      unsubs.forEach((unsub) => {
        unsub()
      })
    },
  }
}
