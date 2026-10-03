import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  createThread,
  getThreadById,
  markThreadHasSavedPlan,
} from '@shared/store/thread-helpers.ts'
import {
  planCriteria,
  type PlanChange,
  type StoredThreadPlan,
} from '@copse/thread-store/plan-schema.ts'
import { el, clear } from '../dom/helpers.ts'
import { mountPlanDocumentEditor } from './plan-document-editor.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import { awaitPendingThreadPersistence } from '../controller/persistence.ts'

const TEMPLATE =
  '# Goal\nDescribe the intended outcome.\n\n# Constraints\nList constraints, or write None.\n\n# Scope\nDescribe what will change and what is excluded.\n\n# Definition of done\n- Describe an observable acceptance criterion.'
const DEFAULT_TITLE = 'Implementation plan'

/** Optional thread artifact, separate from the agent's execution todos. */
export function mountThreadPlanControl(
  api: ApiClient,
  store: AppStore,
  submitTurn: (threadId: string, text: string) => Promise<void>,
): { button: HTMLButtonElement; destroy: () => void } {
  const button = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact', 'data-testid': 'open-plan' },
    'Plan',
  )
  const dialog = el('dialog', {
    id: 'thread-plan-dialog',
    'aria-labelledby': 'thread-plan-heading',
  })
  const heading = el('h3', { id: 'thread-plan-heading' }, 'Plan')
  const status = el('span', { class: 'ui-badge', 'data-testid': 'plan-status' })
  const close = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact' },
    'Close',
  )
  const header = el('div', { class: 'thread-plan-header' }, heading, status, close)
  const description = el(
    'p',
    { class: 'thread-plan-description' },
    'Shape the plan together, then approve a revision to begin.',
  )
  const title = el('input', {
    id: 'plan-title',
    type: 'text',
    maxlength: '200',
    placeholder: 'Plan title',
    'aria-label': 'Plan title',
  })
  const history = el('select', { id: 'plan-revision', 'aria-label': 'Plan revision' })
  const toolbar = el('div', { class: 'thread-plan-toolbar' }, title)
  header.insertBefore(history, close)
  const body = mountPlanDocumentEditor(updateControls, updateControls)
  const selectionQuote = el('blockquote', { class: 'plan-selected-passage', 'aria-live': 'polite' })
  const comments = el('div', { class: 'thread-plan-comments' })
  const feedback = el('textarea', {
    id: 'plan-feedback',
    'aria-label': 'Passage feedback',
    rows: '2',
    placeholder: 'What should change here?',
  })
  const comment = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact' },
    'Add passage feedback',
  )
  const results = el('section', {
    class: 'thread-plan-results',
    'aria-label': 'Completion evidence',
  })
  const error = el('p', { class: 'thread-plan-error', role: 'alert' })
  const hint = el('p', { class: 'thread-plan-hint', 'aria-live': 'polite' })
  const save = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Start planning')
  const refine = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary' },
    'Ask agent to refine',
  )
  const approve = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary' },
    'Approve and implement',
  )
  const abandon = el('button', { type: 'button', class: 'ui-btn ui-btn-ghost' }, 'End plan')
  const actions = el('div', { class: 'thread-plan-actions' }, abandon, save, refine, approve)
  const feedbackForm = el('div', { class: 'plan-feedback-form' }, selectionQuote, feedback, comment)
  const feedbackSection = el(
    'section',
    { class: 'plan-feedback-panel', 'aria-label': 'Plan feedback' },
    el('h4', {}, 'Feedback'),
    el(
      'p',
      { class: 'thread-plan-description' },
      'Select a passage in the document to discuss a specific change.',
    ),
    comments,
    feedbackForm,
  )
  const documentPanel = el('div', { class: 'plan-document-panel' }, toolbar, body.element)
  const sidebar = el('aside', { class: 'plan-review-sidebar' }, feedbackSection, results)
  const workspace = el('div', { class: 'plan-workspace' }, documentPanel, sidebar)
  const footer = el('footer', { class: 'plan-footer' }, error, hint, actions)
  dialog.append(header, description, workspace, footer)
  document.body.append(dialog)
  let owner: { projectId: string; threadId: string } | null = null
  let plan: StoredThreadPlan | null = null
  let revision = 1
  let busy = false
  let generation = 0
  let indicatorKey = ''
  let indicatorSequence = 0
  function labelPlan(value: StoredThreadPlan | null): void {
    button.textContent =
      value?.meta.status === 'draft'
        ? 'Planning'
        : value?.meta.status === 'approved'
          ? 'Approved plan'
          : 'Plan'
  }
  function refreshIndicator(force = false): void {
    const { activeProjectId: projectId, activeThreadId: threadId } = store.getState()
    const key = `${projectId ?? ''}/${threadId ?? ''}`
    button.disabled = !projectId
    if (!force && key === indicatorKey) return
    indicatorKey = key
    const sequence = ++indicatorSequence
    labelPlan(null)
    if (!projectId || !threadId) return
    void api.plans
      .get(projectId, threadId)
      .then((value) => {
        if (sequence === indicatorSequence) labelPlan(value)
      })
      .catch(() => {
        if (sequence === indicatorSequence) button.textContent = 'Plan unavailable'
      })
  }

  function dirty(): boolean {
    if (!plan) return title.value !== DEFAULT_TITLE || body.value !== TEMPLATE
    return (
      revision === plan.meta.currentRevision &&
      (title.value !== plan.meta.title || body.value !== plan.body)
    )
  }
  function running(): boolean {
    return !!owner && getThreadById(store, owner.threadId)?.status === 'running'
  }
  function updateControls(): void {
    const draft = !plan || plan.meta.status === 'draft'
    const current = !plan || revision === plan.meta.currentRevision
    const locked = busy || running()
    const changed = dirty()
    title.readOnly = locked || !draft || !current
    body.readOnly = locked || !draft || !current
    history.disabled = locked || changed
    save.hidden = (!draft && plan?.meta.status !== 'abandoned') || !current
    save.disabled = locked || (!!plan && plan.meta.status !== 'abandoned' && !changed)
    save.textContent =
      plan?.meta.status === 'abandoned'
        ? 'Start new plan'
        : plan
          ? 'Save revision'
          : 'Start planning'
    refine.hidden = !draft || !current
    refine.disabled = locked
    approve.hidden = !plan || !current || plan.meta.status === 'abandoned'
    approve.disabled = locked || changed
    approve.textContent =
      plan?.meta.status === 'approved' ? 'Continue implementation' : 'Approve and implement'
    abandon.hidden = !plan || plan.meta.status === 'abandoned'
    abandon.disabled = locked
    feedbackSection.hidden = plan?.meta.status === 'approved'
    feedbackForm.hidden = !plan || !draft || !current
    comment.disabled = locked || changed || !body.passage || !feedback.value.trim()
    selectionQuote.textContent = body.passage?.text ?? 'No passage selected'
    selectionQuote.classList.toggle('is-empty', !body.passage)
    feedback.disabled = locked || changed
    close.disabled = busy
    close.textContent = changed ? 'Discard edits and close' : 'Close'
    hint.textContent = running()
      ? 'The agent is running. Review is available; changes unlock when the turn finishes.'
      : changed
        ? 'Unsaved changes. Save a revision before commenting or approving.'
        : plan?.meta.status === 'draft'
          ? `Approval applies to revision ${String(plan.meta.currentRevision)} and starts a new implementation turn.`
          : plan?.meta.status === 'approved'
            ? `Approved revision ${String(plan.meta.approvedRevision)} · implementation uses your existing tool permissions.`
            : 'Use the composer for a quick task, or start a plan here.'
  }

  function render(): void {
    labelPlan(plan)
    dialog.classList.toggle('is-approved', plan?.meta.status === 'approved')
    title.value = plan?.meta.title ?? DEFAULT_TITLE
    body.value = plan?.body ?? TEMPLATE
    revision = plan?.meta.currentRevision ?? 1
    status.textContent = plan ? `${plan.meta.status} · r${String(revision)}` : 'Optional'
    clear(history)
    for (let n = revision; n >= 1; n--)
      history.append(el('option', { value: String(n) }, `Revision ${String(n)}`))
    history.hidden = !plan
    feedback.value = ''
    renderComments()
    clear(results)
    results.hidden = plan?.meta.status !== 'approved'
    if (plan?.meta.status === 'approved') {
      results.append(
        el('h4', {}, 'Completion evidence'),
        el(
          'p',
          {},
          plan.completion
            ? 'Agent-reported results for the approved revision.'
            : 'No completion report yet. Every criterion remains unverified.',
        ),
      )
      for (const criterion of planCriteria(plan.body)) {
        const result = plan.completion?.results.find((item) => item.criterionId === criterion.id)
        const row = el('div', {
          class: 'thread-plan-result',
          'data-status': result?.status ?? 'unverified',
        })
        row.append(
          el('span', { class: 'ui-badge' }, result?.status ?? 'unverified'),
          el('strong', {}, criterion.label),
          el('p', {}, result?.evidence ?? 'Verification has not been reported.'),
        )
        results.append(row)
      }
    }
    updateControls()
  }
  function renderComments(): void {
    clear(comments)
    for (const item of plan?.comments.filter((item) => item.revision === revision) ?? []) {
      const passage =
        item.quote ?? (item.anchor ? body.value.slice(item.anchor.start, item.anchor.end) : '')
      comments.append(
        el(
          'div',
          { class: 'thread-plan-comment' },
          el('blockquote', {}, passage),
          el('p', {}, item.body),
        ),
      )
    }
  }
  async function act(operation: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    error.textContent = ''
    updateControls()
    try {
      await operation()
    } catch (err) {
      error.textContent = ipcErrorMessage(err, 'The plan could not be updated.')
    } finally {
      busy = false
      updateControls()
    }
  }
  async function change(input: PlanChange): Promise<void> {
    const target = owner
    if (!target) return
    const updated = await api.plans.change(target.projectId, target.threadId, input)
    if (updated) markThreadHasSavedPlan(store, target.threadId)
    store.emit('thread_plan_changed', target.threadId)
    if (owner === target) {
      plan = updated
      render()
    }
  }
  async function saveDraft(): Promise<void> {
    if (plan && !dirty()) return
    await change(
      plan
        ? {
            action: 'revise',
            planId: plan.meta.planId,
            revision: plan.meta.currentRevision,
            title: title.value,
            body: body.value,
          }
        : { action: 'create', title: title.value, body: body.value },
    )
  }
  async function submit(text: string): Promise<void> {
    if (!owner || running()) return
    const threadId = owner.threadId
    dialog.close()
    await submitTurn(threadId, text)
  }
  function openPlan(): void {
    if (dialog.open || busy) return
    const projectId = store.getState().activeProjectId
    if (!projectId) return
    const threadId = store.getState().activeThreadId ?? createThread(store)
    owner = { projectId, threadId }
    const token = ++generation
    plan = null
    render()
    dialog.showModal()
    void act(async () => {
      await awaitPendingThreadPersistence()
      const loaded = await api.plans.get(projectId, threadId)
      if (token !== generation) return
      plan = loaded
      render()
    })
  }
  button.addEventListener('click', openPlan)
  const unsubOpen = store.on('thread_plan_open', openPlan)
  close.addEventListener('click', () => {
    dialog.close()
  })
  dialog.addEventListener('cancel', (event) => {
    if (busy || dirty()) {
      event.preventDefault()
      error.textContent = 'Save your revision or choose Discard edits and close.'
    }
  })
  title.addEventListener('input', updateControls)
  feedback.addEventListener('input', updateControls)
  save.addEventListener('click', () => {
    if (plan?.meta.status === 'abandoned') {
      plan = null
      render()
    } else void act(saveDraft)
  })
  refine.addEventListener('click', () => {
    void act(async () => {
      await saveDraft()
      if (plan)
        await submit(
          `Review and refine draft plan revision ${String(plan.meta.currentRevision)}. Ask focused questions where needed, address passage feedback, and save the next revision for my review.`,
        )
    })
  })
  comment.addEventListener('click', () => {
    const passage = body.passage
    if (!plan || !passage) return
    const input: PlanChange = {
      action: 'comment',
      planId: plan.meta.planId,
      revision,
      body: feedback.value,
      anchor: { start: passage.start, end: passage.end },
    }
    void act(() => change(input))
  })
  approve.addEventListener('click', () => {
    void act(async () => {
      if (!plan || dirty()) return
      if (plan.meta.status === 'draft')
        await change({
          action: 'approve',
          planId: plan.meta.planId,
          revision: plan.meta.currentRevision,
          contentHash: plan.contentHash,
        })
      if (plan.meta.status === 'approved')
        await submit(
          `Implement approved plan “${plan.meta.title}”, revision ${String(plan.meta.currentRevision)}. Report completion evidence against each definition-of-done criterion.`,
        )
    })
  })
  abandon.addEventListener('click', () => {
    void act(async () => {
      if (!plan) return
      await change({
        action: 'abandon',
        planId: plan.meta.planId,
        revision: plan.meta.currentRevision,
      })
      dialog.close()
    })
  })
  history.addEventListener('change', () => {
    void act(async () => {
      if (!owner || !plan) return
      const requested = Number(history.value)
      const previous = await api.plans.revision(
        owner.projectId,
        owner.threadId,
        plan.meta.planId,
        requested,
      )
      if (previous === null) throw new Error('Revision could not be loaded')
      revision = requested
      body.value = previous
      renderComments()
    })
  })
  const unsub = store.on('threads_changed', () => {
    refreshIndicator()
    if (
      owner &&
      (owner.projectId !== store.getState().activeProjectId ||
        owner.threadId !== store.getState().activeThreadId)
    ) {
      generation++
      owner = null
      dialog.close()
    }
  })
  const unsubStatus = store.on('thread_status_changed', (threadId) => {
    if (
      store.getState().activeThreadId === threadId &&
      getThreadById(store, threadId)?.status !== 'running'
    )
      refreshIndicator(true)
    if (owner?.threadId !== threadId || !dialog.open) return
    updateControls()
    if (!running() && !busy && !dirty()) {
      const target = owner
      void act(async () => {
        const loaded = await api.plans.get(target.projectId, target.threadId)
        if (owner === target) {
          plan = loaded
          render()
        }
      })
    }
  })
  refreshIndicator()
  return {
    button,
    destroy: (): void => {
      generation++
      indicatorSequence++
      owner = null
      unsub()
      unsubOpen()
      unsubStatus()
      body.destroy()
      dialog.remove()
    },
  }
}
