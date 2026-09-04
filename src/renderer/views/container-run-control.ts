import type { ApiClient } from '../../preload/api.d.ts'
import type { ContainerRunProgress } from '@shared/types/container-run.ts'
import { clear, el } from '../dom/helpers.ts'
import { uiActions, uiField } from '../ui/index.ts'
import { createOverlayDialog, type OverlayDialog } from './dialog-shell.ts'
import { showErrorToast, showToast } from './toast.ts'

/**
 * Run the active thread unattended inside a disposable container
 * (`docs/plans/thread-in-container.md`), from the composer footer.
 *
 * One dialog, two faces. Before a run it is the arming form: the prompt (the
 * composer draft, editable), the wall-clock and token budgets, and what the
 * guest will be allowed to reach. During and after a run it is the status view:
 * the phase, a log tail, and the review record — what was deferred, what was
 * committed, where the commits landed. A banner over the composer mirrors the
 * phase so the run stays visible while the dialog is closed.
 *
 * Everything sensitive stays in the main process: the renderer sends a prompt,
 * a model id and two numbers, and gets JSON snapshots back.
 */

export interface ContainerRunContext {
  getActiveThreadId: () => string | null
  getActiveProjectId: () => string | null
  /** The concrete model the thread runs on, as the footer shows it. */
  getModel: () => string
  /** The composer draft, to prefill the prompt. */
  getDraft: () => string
}

const DEFAULT_WALL_CLOCK_MINUTES = 120
const DEFAULT_TOKEN_CEILING = 2_000_000

const PHASE_LABEL: Record<ContainerRunProgress['phase'], string> = {
  preparing: 'Preparing',
  'building-image': 'Building the worker image',
  starting: 'Starting the container',
  running: 'Running unattended',
  collecting: 'Collecting the result',
  finished: 'Finished',
  failed: 'Failed',
}

function isLive(progress: ContainerRunProgress | null): boolean {
  return progress !== null && progress.phase !== 'finished' && progress.phase !== 'failed'
}

function formatDuration(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 90) return `${String(seconds)}s`
  return `${String(Math.round(seconds / 60))} min`
}

export function mountContainerRunControl(
  api: Pick<ApiClient, 'container'>,
  context: ContainerRunContext,
  onStateChanged: () => void,
): {
  element: HTMLElement
  menuLabel: () => string
  open: () => void
  refresh: () => void
  destroy: () => void
} {
  const runs = new Map<string, ContainerRunProgress>()
  let refreshSequence = 0
  let overlay: OverlayDialog | null = null

  // ── Banner ────────────────────────────────────────────────────────────
  const text = el('span', { class: 'container-run-text' })
  const details = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary container-run-details' },
    'Details',
  )
  const element = el(
    'div',
    { class: 'container-run-banner', role: 'status', 'aria-live': 'polite', hidden: '' },
    el('span', { class: 'container-run-icon', 'aria-hidden': 'true' }, '▣'),
    text,
    details,
  )

  function activeRun(): ContainerRunProgress | null {
    const threadId = context.getActiveThreadId()
    return threadId ? (runs.get(threadId) ?? null) : null
  }

  function renderBanner(): void {
    const run = activeRun()
    element.hidden = run === null
    if (!run) {
      text.textContent = ''
      delete element.dataset['phase']
      onStateChanged()
      return
    }
    element.dataset['phase'] = run.phase
    const result = run.record?.result
    const summary =
      run.phase === 'finished' && result
        ? `${String(result.commits.length)} commit${result.commits.length === 1 ? '' : 's'} back, ${String(result.deferrals.length)} waiting for review.`
        : run.phase === 'failed'
          ? (run.error ?? 'The run did not complete.')
          : `${run.model} · reaches only ${run.egressAllowlist.join(', ')}.`
    text.textContent = `Container run: ${PHASE_LABEL[run.phase].toLowerCase()}. ${summary}`
    onStateChanged()
  }

  // ── Dialog ────────────────────────────────────────────────────────────
  function ensureDialog(): OverlayDialog {
    overlay ??= createOverlayDialog({
      id: 'container-run-dialog',
      className: 'container-run-dialog',
    })
    return overlay
  }

  function renderDialog(): void {
    if (!overlay?.isOpen()) return
    const run = activeRun()
    clear(overlay.dialog)
    overlay.dialog.append(run ? statusView(run) : armForm())
  }

  function armForm(): HTMLElement {
    const prompt = el('textarea', {
      class: 'container-run-prompt',
      rows: '6',
      'aria-label': 'Task for the unattended run',
    })
    prompt.value = context.getDraft()
    const minutes = el('input', {
      type: 'number',
      class: 'container-run-minutes',
      min: '1',
      max: '1440',
      step: '1',
    })
    minutes.value = String(DEFAULT_WALL_CLOCK_MINUTES)
    const tokens = el('input', {
      type: 'number',
      class: 'container-run-tokens',
      min: '1000',
      step: '1000',
    })
    tokens.value = String(DEFAULT_TOKEN_CEILING)
    const model = context.getModel()
    const start = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-primary container-run-start' },
      'Start unattended run',
    )
    const cancel = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary container-run-cancel' },
      'Cancel',
    )
    cancel.addEventListener('click', () => overlay?.close())
    start.addEventListener('click', () => {
      const threadId = context.getActiveThreadId()
      const projectId = context.getActiveProjectId()
      if (!threadId || !projectId) return
      const wallClockMs = Math.max(1, Number(minutes.value) || DEFAULT_WALL_CLOCK_MINUTES) * 60_000
      const tokenCeiling = Math.max(1000, Number(tokens.value) || DEFAULT_TOKEN_CEILING)
      start.disabled = true
      void api.container
        .runThread({
          projectId,
          threadId,
          prompt: prompt.value,
          model,
          budgets: { wallClockMs, tokenCeiling },
        })
        .then((progress) => {
          update(progress)
          renderDialog()
        })
        .catch((error: unknown) => {
          start.disabled = false
          showErrorToast('Could not start the container run', error)
        })
    })
    return el(
      'div',
      { class: 'container-run-form' },
      el('h2', { class: 'container-run-title' }, 'Run this thread unattended in a container'),
      el(
        'p',
        { class: 'container-run-intro' },
        'A disposable container gets a snapshot of the checkout and runs the task with no prompts: ' +
          'anything that stays inside the container runs on its own, anything that would leave it ' +
          '(a push, a publish, a GitHub write) is queued for your review, and the result comes back as ' +
          'commits you can inspect before merging.',
      ),
      uiField({ label: 'Task', control: prompt }),
      el(
        'div',
        { class: 'container-run-budgets' },
        uiField({ label: 'Stop after (minutes)', control: minutes }),
        uiField({ label: 'Token ceiling', control: tokens }),
      ),
      el(
        'p',
        { class: 'field-hint container-run-model-hint' },
        `Model: ${model}. The container can reach only the model's endpoint; the key is scoped to the run.`,
      ),
      uiActions(cancel, start, { className: 'container-run-actions' }),
    )
  }

  function statusView(run: ContainerRunProgress): HTMLElement {
    const result = run.record?.result ?? null
    const rows: HTMLElement[] = []
    const row = (label: string, value: string): HTMLElement =>
      el('div', { class: 'container-run-row' }, el('dt', {}, label), el('dd', {}, value))
    rows.push(row('Phase', PHASE_LABEL[run.phase]))
    rows.push(row('Model', run.model))
    rows.push(row('Reachable origins', run.egressAllowlist.join(', ') || 'none'))
    rows.push(
      row(
        'Elapsed',
        formatDuration(run.startedAt, run.finishedAt ?? Date.now()) +
          (run.finishedAt === null ? ' so far' : ''),
      ),
    )
    if (run.record) {
      rows.push(row('Image', run.record.imageDigest?.slice(0, 19) ?? run.record.image))
      rows.push(
        row(
          'Containment',
          run.record.attestation.network === 'brokered'
            ? 'read-only rootfs, no capabilities, brokered egress'
            : 'read-only rootfs, no capabilities, no network',
        ),
      )
      rows.push(row('Secret canary', run.record.secretCanary.present ? 'PRESENT' : 'absent'))
      rows.push(row('Teardown', run.record.teardown))
    }
    if (result) {
      rows.push(row('Outcome', result.stopReason))
      rows.push(row('Prompts reached a handler', String(result.promptsAttempted)))
      rows.push(
        row(
          'Tokens',
          `${String(result.usage.inputTokens)} in / ${String(result.usage.outputTokens)} out`,
        ),
      )
      rows.push(row('Commits', run.record?.carryOutRef ?? 'none'))
    }
    if (run.error) rows.push(row('Error', run.error))

    const sections: HTMLElement[] = [
      el('h2', { class: 'container-run-title' }, 'Unattended container run'),
      el('dl', { class: 'container-run-summary' }, ...rows),
    ]
    if (result && result.deferrals.length > 0) {
      sections.push(
        el(
          'section',
          { class: 'container-run-section container-run-deferrals' },
          el('h3', {}, `Waiting for your review (${String(result.deferrals.length)})`),
          el(
            'ul',
            {},
            ...result.deferrals.map((entry) =>
              el(
                'li',
                {},
                el('strong', {}, entry.title),
                entry.reasons?.length ? ` — ${entry.reasons.join('; ')}` : '',
              ),
            ),
          ),
        ),
      )
    }
    if (result && result.commits.length > 0) {
      sections.push(
        el(
          'section',
          { class: 'container-run-section container-run-commits' },
          el('h3', {}, `Commits on ${run.record?.carryOutRef ?? 'the run ref'}`),
          el('ul', {}, ...result.commits.map((line) => el('li', { class: 'mono' }, line))),
        ),
      )
    }
    if (result?.finalText) {
      sections.push(
        el(
          'section',
          { class: 'container-run-section' },
          el('h3', {}, 'The agent said'),
          el('p', {}, result.finalText),
        ),
      )
    }
    const log = el('pre', { class: 'container-run-log' }, run.log.join('\n'))
    sections.push(el('section', { class: 'container-run-section' }, el('h3', {}, 'Log'), log))
    const close = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary container-run-close' },
      'Close',
    )
    close.addEventListener('click', () => overlay?.close())
    const actions: HTMLElement[] = [close]
    if (!isLive(run)) {
      const again = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-primary container-run-again' },
        'Start another run',
      )
      again.addEventListener('click', () => {
        // Forget the finished run for this thread so the form comes back; the
        // record itself stays on disk under the profile.
        const threadId = context.getActiveThreadId()
        if (threadId) runs.delete(threadId)
        renderBanner()
        renderDialog()
      })
      actions.push(again)
    }
    sections.push(uiActions(...actions, { className: 'container-run-actions' }))
    const view = el('div', { class: 'container-run-status' }, ...sections)
    view.dataset['phase'] = run.phase
    return view
  }

  // ── State ─────────────────────────────────────────────────────────────
  function update(progress: ContainerRunProgress): void {
    const previous = runs.get(progress.threadId)
    runs.set(progress.threadId, progress)
    if (previous && isLive(previous) && !isLive(progress)) {
      const result = progress.record?.result
      if (progress.phase === 'finished' && result) {
        showToast(
          `Container run finished: ${String(result.commits.length)} commit(s) back, ${String(result.deferrals.length)} waiting for review.`,
          { variant: 'info', durationMs: 10_000 },
        )
      } else {
        showToast(`Container run failed: ${progress.error ?? 'no result'}`, {
          variant: 'error',
          durationMs: 10_000,
        })
      }
    }
    if (progress.threadId === context.getActiveThreadId()) {
      renderBanner()
      renderDialog()
    }
  }

  function refresh(): void {
    const threadId = context.getActiveThreadId()
    const sequence = ++refreshSequence
    if (!threadId) {
      renderBanner()
      return
    }
    void api.container
      .getRun(threadId)
      .then((progress) => {
        if (sequence !== refreshSequence) return
        if (progress) runs.set(threadId, progress)
        renderBanner()
        renderDialog()
      })
      .catch((error: unknown) => {
        showErrorToast('Could not read the container run', error)
      })
  }

  function open(): void {
    if (!context.getActiveThreadId()) return
    const dialog = ensureDialog()
    dialog.open()
    renderDialog()
  }

  details.addEventListener('click', open)
  const unsubscribe = api.container.onRunChanged(update)
  refresh()

  return {
    element,
    menuLabel: () =>
      isLive(activeRun()) ? 'Show container run' : 'Run unattended in a container…',
    open,
    refresh,
    destroy: (): void => {
      unsubscribe()
      overlay?.dialog.remove()
      overlay = null
    },
  }
}
