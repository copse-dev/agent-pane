import type { ApiClient } from '../../preload/api.d.ts'
import type { ContainerModelVerdict, ContainerRunProgress } from '@shared/types/container-run.ts'
import type { AppStore } from '@shared/store/store.ts'
import { isRecord } from '@shared/unknown-value.ts'
import {
  CONTAINER_RUN_ADOPT_EVENT,
  containerRunToolCallId,
  latestContainerRun,
  noteAdoptionOnCard,
  syncContainerRunCard,
  type LatestContainerRun,
} from '@shared/store/container-run-card.ts'
import {
  addMessage,
  addUsageDelta,
  getThreadById,
  markThreadUnread,
} from '@shared/store/thread-helpers.ts'
import type { ContainerRunRequest } from '@shared/types/container-run.ts'
import { parseAcpModel } from '@shared/acp.ts'
import { findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import { containerAcpAgentTitles } from '@shared/container-acp-agents.ts'
import { clear, el } from '../dom/helpers.ts'
import { uiActions, uiField } from '../ui/index.ts'
import {
  fetchModelOptions,
  modelDisplayLabel,
  type FetchModelOptionsOpts,
  type ModelOption,
  type ModelOptionsApi,
} from './model-options.ts'
import { mountModelSelectPicker, type ModelSelectPicker } from './model-picker.ts'
import { createOverlayDialog, type OverlayDialog } from './dialog-shell.ts'
import { showErrorToast, showToast } from './toast.ts'

/**
 * Run the active thread unattended inside a disposable container
 * (`docs/plans/thread-in-container.md`), from the composer footer.
 *
 * One dialog, two faces. Before a run it authorises one: the task, the model to
 * run it on, the wall-clock and token budgets, and what the guest will be
 * allowed to reach. During and after a run it is the status view: the phase, a
 * log tail, and the review record — what was deferred, what was committed,
 * where the commits landed. A banner over the composer mirrors the phase so the
 * run stays visible while the dialog is closed.
 *
 * The first face is a confirmation, not a compose step. The task is whatever is
 * already in the composer, shown read-only: both ways in (an existing thread,
 * the new-thread input) mean the user has just typed it, and asking them to
 * confirm their own sentence in a second textarea is a step that buys nothing.
 * It becomes editable only when there is no draft, because then there is
 * genuinely nothing to run. What the dialog is for is the part the composer
 * cannot say: this runs unwatched, on this model, until one of these two
 * budgets stops it.
 *
 * Everything sensitive stays in the main process: the renderer sends a prompt,
 * a model id and two numbers, and gets JSON snapshots back.
 */

export interface ContainerRunContext {
  /** The thread store: the run is written into its thread as a card (A13). */
  store: AppStore
  getActiveThreadId: () => string | null
  getActiveProjectId: () => string | null
  /** The concrete model the thread runs on, as the footer shows it. */
  getModel: () => string
  /** The composer draft: the task the run will carry out. */
  getDraft: () => string
  /** Empty the composer once its draft has become a run's task. */
  clearDraft: () => void
}

/** What the composer needs to know to offer the container as a target (A14). */
export interface ContainerFollowUpTarget {
  /** The thread has a container run to continue. */
  available: boolean
  /** That run is still going: a follow-up cannot reach it yet. */
  live: boolean
  /** The run is the thread's last turn, so the container is the natural next hop. */
  defaultToContainer: boolean
}

const DEFAULT_WALL_CLOCK_MINUTES = 120
const DEFAULT_TOKEN_CEILING = 2_000_000

const PHASE_LABEL: Record<ContainerRunProgress['phase'], string> = {
  preparing: 'Preparing',
  'building-image': 'Building the worker image',
  starting: 'Starting the container',
  installing: 'Installing dependencies',
  running: 'Running unattended',
  collecting: 'Collecting the result',
  finished: 'Finished',
  failed: 'Failed',
}

function isLive(progress: ContainerRunProgress | null): boolean {
  return progress !== null && progress.phase !== 'finished' && progress.phase !== 'failed'
}

function elapsedLabel(run: ContainerRunProgress): string {
  return (
    formatDuration(run.startedAt, run.finishedAt ?? Date.now()) +
    (run.finishedAt === null ? ' so far' : '')
  )
}

function formatDuration(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 90) return `${String(seconds)}s`
  return `${String(Math.round(seconds / 60))} min`
}

/**
 * The roster the run's model picker offers: every model the composer would,
 * with the ones a container cannot run greyed out and told why.
 *
 * Provider-backed models (`includeAgentModels: false`) always run: the guest
 * is given that provider's key. An agent model runs only when the worker
 * image carries the agent and its vendor's key is available
 * (`container-acp-agents.ts`) — then the run gives the agent that key, scoped
 * to the run, never the desktop login. The reason on a disabled row is the
 * per-agent one, so "needs a Gemini API key" reads as the thing to go and do
 * and "signs in through a browser" reads as the thing that cannot be done.
 *
 * `availability` is the main-process resolver's own verdict for the agent
 * rows, asked in one round trip. Nothing here decides which key counts: a
 * key in Settings and one in the environment both run, and the same code
 * that would refuse the start is the code that greys the row.
 */
export async function loadRunModelOptions(
  fetch: (opts?: FetchModelOptionsOpts) => Promise<ModelOption[]>,
  availability: (models: string[]) => Promise<Record<string, ContainerModelVerdict>>,
): Promise<ModelOption[]> {
  const [all, runnable] = await Promise.all([fetch(), fetch({ includeAgentModels: false })])
  // An agent model is never provider-backed, whatever the provider-only fetch
  // says: it keeps the picker's current value on the roster as a fallback row
  // even when that value is an agent, and the thread's own model is exactly
  // that value. Treating it as runnable skipped the resolver, so the row had
  // no verdict, no opt-in, and a Start that could only be refused.
  const canRun = new Set(
    runnable.filter((option) => parseAcpModel(option.value) === null).map((option) => option.value),
  )
  const agentRows = all.filter((option) => !canRun.has(option.value))
  const verdicts = agentRows.length > 0 ? await availability(agentRows.map((o) => o.value)) : {}
  return all.map((option) => {
    if (canRun.has(option.value)) return option
    // Only a row the resolver did not answer at all gets the generic reason.
    const verdict: ContainerModelVerdict = Object.hasOwn(verdicts, option.value)
      ? (verdicts[option.value] ?? { reason: 'not available in a container' })
      : { reason: 'not available in a container' }
    if (verdict.reason !== null) {
      return { ...option, disabled: true, label: `${option.label} — ${verdict.reason}` }
    }
    // Offered, not yet authorised: the row is pickable so the opt-in can be
    // shown for it, and the suffix says what picking it will ask for.
    return verdict.loginOffered
      ? {
          ...option,
          label: `${option.label} — on your ${verdict.loginOffered.agentTitle} sign-in (opt in)`,
        }
      : option
  })
}

/**
 * Why the Start button is disabled, or null when the run may start. An agent
 * model is startable only once the resolver has answered for it: the roster
 * loads after the dialog opens, and a click in that window would reach the
 * resolver with no opt-in the dialog could have shown — the "opt in below"
 * refusal with nothing below it.
 */
export function startBlocker(state: {
  task: string
  model: string
  verdict: ContainerModelVerdict | undefined
  rosterLoaded: boolean
  loginChecked: boolean
}): string | null {
  if (state.task.trim().length === 0) return 'Describe the task first'
  if (parseAcpModel(state.model) === null) return null
  if (state.verdict === undefined) {
    return state.rosterLoaded
      ? `${modelDisplayLabel(state.model)} is not available in a container`
      : 'Checking whether this agent can run in a container…'
  }
  if (state.verdict.reason !== null) {
    return `${modelDisplayLabel(state.model)}: ${state.verdict.reason}`
  }
  if (state.verdict.loginOffered && !state.loginChecked) {
    return `Tick "Use my ${state.verdict.loginOffered.agentTitle} sign-in for this run" to start`
  }
  return null
}

/** The sentence under the picker whenever an agent model is on the roster. */
export function agentModelsNote(): string {
  const titles = containerAcpAgentTitles()
  const named =
    titles.length > 1
      ? `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1] ?? ''}`
      : (titles[0] ?? '')
  return (
    `Agent models run as their own process. ${named} can run unattended with an API key from Settings, ` +
    'scoped to the run. Codex and Gemini CLI can also run on your desktop sign-in if you opt in per run; ' +
    'an agent that only signs in through a browser cannot.'
  )
}

export function mountContainerRunControl(
  api: Pick<ApiClient, 'container' | 'alerts'> & ModelOptionsApi,
  context: ContainerRunContext,
  onStateChanged: () => void,
): {
  element: HTMLElement
  menuLabel: () => string
  open: () => void
  refresh: () => void
  /** Whether, and how, the composer should offer the container as a target. */
  followUpTarget: () => ContainerFollowUpTarget
  /** Continue the thread's latest run with this prompt; false when nothing started. */
  followUp: (prompt: string) => Promise<boolean>
  destroy: () => void
} {
  const runs = new Map<string, ContainerRunProgress>()
  let refreshSequence = 0
  let overlay: OverlayDialog | null = null
  /**
   * The task the last run in this session was started with, so "Run again"
   * against an empty composer offers it rather than an empty field. Session
   * memory only, which matches the run registry — it is session-only too.
   */
  let lastPrompt = ''
  /**
   * The arming form is rebuilt on every render, so the picker mounted against
   * the previous select has to be torn down or it leaks its menu listeners.
   */
  let modelPicker: ModelSelectPicker | null = null

  // ── Banner ────────────────────────────────────────────────────────────
  const text = el('span', { class: 'container-run-text' })
  const details = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary container-run-details' },
    'Details',
  )
  // A finished or failed run can be waved away; the record stays reachable
  // from the footer menu, and a new run on the thread brings the banner back.
  // A live run cannot be dismissed: its banner is the one place that says a
  // container is still running on this thread.
  const dismiss = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost container-run-dismiss',
      'aria-label': 'Dismiss this container run notice',
      title: 'Dismiss',
    },
    '×',
  )
  const element = el(
    'div',
    { class: 'container-run-banner', role: 'status', 'aria-live': 'polite', hidden: '' },
    el('span', { class: 'container-run-icon', 'aria-hidden': 'true' }, '▣'),
    text,
    details,
    dismiss,
  )
  /** Runs whose banner was dismissed, by thread → runtime, so a new run reappears. */
  const dismissed = new Map<string, string | null>()
  dismiss.addEventListener('click', () => {
    const threadId = context.getActiveThreadId()
    const run = activeRun()
    if (!threadId || !run || isLive(run)) return
    dismissed.set(threadId, run.runtimeId)
    renderBanner()
  })

  function activeRun(): ContainerRunProgress | null {
    const threadId = context.getActiveThreadId()
    return threadId ? (runs.get(threadId) ?? null) : null
  }

  function renderBanner(): void {
    const run = activeRun()
    const threadId = context.getActiveThreadId()
    const wavedAway =
      run !== null &&
      threadId !== null &&
      !isLive(run) &&
      dismissed.has(threadId) &&
      dismissed.get(threadId) === run.runtimeId
    element.hidden = run === null || wavedAway
    dismiss.hidden = run === null || isLive(run)
    if (!run) {
      text.textContent = ''
      delete element.dataset['phase']
      onStateChanged()
      return
    }
    element.dataset['phase'] = run.phase
    const result = run.record?.result
    const fetched = run.record?.carryOut.ref !== null && run.record?.carryOut.ref !== undefined
    const commits =
      result === undefined || result === null
        ? ''
        : result.commits.length === 0
          ? 'no commits'
          : `${String(result.commits.length)} commit${result.commits.length === 1 ? '' : 's'} ${fetched ? 'back' : 'made but NOT fetched'}`
    const summary =
      run.phase === 'finished' && result
        ? `${commits}, ${String(result.deferrals.length)} waiting for review.`
        : run.phase === 'failed'
          ? (run.error ?? 'The run did not complete.')
          : `${run.model} · limited to the egress allowlist.`
    text.textContent = `Container run: ${PHASE_LABEL[run.phase].toLowerCase()}. ${summary}`
    onStateChanged()
  }

  // ── Dialog ────────────────────────────────────────────────────────────
  function ensureDialog(): OverlayDialog {
    if (!overlay) {
      overlay = createOverlayDialog({
        id: 'container-run-dialog',
        className: 'container-run-dialog',
      })
      // A closed dialog has nothing to tick; the clock restarts on reopen.
      overlay.dialog.addEventListener('close', stopElapsedClock)
    }
    return overlay
  }

  // The elapsed row on a live run is a clock, not a log line: it ticks on its
  // own rather than waiting for the next progress update to repaint the face.
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  function stopElapsedClock(): void {
    if (elapsedTimer !== null) clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  function startElapsedClock(run: ContainerRunProgress): void {
    stopElapsedClock()
    if (!isLive(run)) return
    elapsedTimer = setInterval(() => {
      const cell = overlay?.dialog.querySelector('.container-run-elapsed')
      if (!cell || !overlay?.isOpen()) {
        stopElapsedClock()
        return
      }
      cell.textContent = elapsedLabel(run)
    }, 1000)
  }

  function renderDialog(): void {
    if (!overlay?.isOpen()) return
    const run = activeRun()
    // Both faces replace the whole dialog, so the picker mounted by a previous
    // arming form is about to be detached: drop it before its select goes.
    modelPicker?.destroy()
    modelPicker = null
    clear(overlay.dialog)
    overlay.dialog.append(run ? statusView(run) : armForm())
    if (run) startElapsedClock(run)
    else stopElapsedClock()
  }

  function armForm(): HTMLElement {
    const draft = context.getDraft().trim()
    // Read-only means one specific thing: this is the composer draft you just
    // typed, quoted back. Falling back to the last run's task (for "Run again"
    // against an empty composer) is a starting point instead, so it stays
    // editable — a re-run is usually the same task with a correction.
    const quotesDraft = draft.length > 0
    const task = el('textarea', {
      class: 'container-run-prompt',
      rows: '6',
      'aria-label': quotesDraft
        ? 'Task the unattended run will carry out'
        : 'Task for the unattended run',
    })
    task.value = quotesDraft ? draft : lastPrompt
    if (quotesDraft) {
      task.readOnly = true
      task.classList.add('is-readonly')
    }

    // The same searchable picker the composer and Settings use, over a native
    // select that stays the value carrier. Rolling a plain <select> here gave a
    // second, worse way to choose a model in the same app.
    const modelSelect = el('select', {
      class: 'container-run-model',
      name: 'containerRunModel',
    })
    // The thread's model is the default and is always present, so the control
    // names a model before the option list resolves — and still does if it fails.
    let chosenModel = context.getModel()
    modelSelect.append(el('option', { value: chosenModel }, modelDisplayLabel(chosenModel)))
    modelSelect.value = chosenModel
    modelSelect.addEventListener('change', () => {
      chosenModel = modelSelect.value
      renderEgressHint()
      renderLoginOptIn()
    })
    // The resolver's verdict per agent row, kept so choosing a row that runs
    // only on the user's sign-in can reveal the opt-in for it.
    const verdicts = new Map<string, ContainerModelVerdict>()
    // The field has to exist before the picker mounts: `mountModelSelectPicker`
    // inserts its trigger with `select.after(...)`, which is a no-op while the
    // select still has no parent.
    const modelField = uiField({ label: 'Model', control: modelSelect })
    // Shown once the roster confirms there is an agent model to explain. A
    // disabled row cannot be clicked for its reason, and an enabled agent row
    // is a promise worth spelling out: it runs on a key, not on the login.
    const agentNote = el('p', { class: 'field-hint container-run-agent-note', hidden: '' })
    agentNote.textContent = agentModelsNote()
    modelPicker = mountModelSelectPicker(modelSelect, {
      loadOptions: async (current) => {
        const options = await loadRunModelOptions(
          (opts) => fetchModelOptions(api, current, opts),
          async (models) => {
            const answered = await api.container.modelAvailability(models)
            for (const [model, verdict] of Object.entries(answered)) verdicts.set(model, verdict)
            return answered
          },
        )
        agentNote.hidden = !options.some(
          (option) => option.disabled === true || parseAcpModel(option.value) !== null,
        )
        renderLoginOptIn()
        return options
      },
      ariaLabel: 'Model for the unattended run',
      loadOnMount: false,
    })
    let rosterLoaded = false
    void modelPicker
      .refresh(chosenModel)
      .catch(async (error: unknown) => {
        console.error('[container-run] could not list models:', error)
        // The roster failed, but the thread's own model can still be asked
        // about on its own, so the preselected row is not stuck on "checking".
        if (parseAcpModel(chosenModel) !== null) {
          const answered = await api.container.modelAvailability([chosenModel]).catch(() => ({}))
          for (const [model, verdict] of Object.entries(answered)) verdicts.set(model, verdict)
        }
      })
      .finally(() => {
        rosterLoaded = true
        renderLoginOptIn()
      })

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

    const egressHint = el('p', { class: 'field-hint container-run-model-hint' })
    function renderEgressHint(): void {
      egressHint.textContent =
        `The container can reach only ${modelDisplayLabel(chosenModel)}'s endpoint; ` +
        'the key is scoped to the run and blanked once the guest holds it.'
    }
    renderEgressHint()

    // The sign-in opt-in (decision A1′): shown only for an agent the resolver
    // says would run on the user's sign-in, and never ticked by default. It is
    // the whole account rather than a scoped key, and a token refresh in the
    // guest can sign the desktop out — so the hint says both before the box.
    const loginOptIn = el('input', {
      type: 'checkbox',
      class: 'container-run-agent-login',
      name: 'containerRunAgentLogin',
    })
    const loginLabel = el(
      'label',
      { class: 'container-run-agent-login-label' },
      loginOptIn,
      el('span', { class: 'container-run-agent-login-text' }),
    )
    const loginHint = el('p', { class: 'field-hint container-run-agent-login-hint' })
    const loginField = el(
      'div',
      { class: 'container-run-agent-login-field', hidden: '' },
      loginLabel,
      loginHint,
    )
    function loginOffer(): { agentTitle: string } | null {
      return verdicts.get(chosenModel)?.loginOffered ?? null
    }
    function renderLoginOptIn(): void {
      const offer = loginOffer()
      loginField.hidden = offer === null
      if (offer === null) {
        loginOptIn.checked = false
      } else {
        const text = loginLabel.querySelector('.container-run-agent-login-text')
        if (text) text.textContent = `Use my ${offer.agentTitle} sign-in for this run`
        loginHint.textContent =
          `${offer.agentTitle} has no API key in Settings. Ticking this copies its sign-in files (only those: ` +
          "no transcripts, no history) into the container's throwaway home for this run and discards them with it. " +
          'That is your whole account, not a scoped key, and a token refresh inside the run may sign ' +
          'the desktop out. Adding an API key in Settings avoids both.'
      }
      renderStartState()
    }
    loginOptIn.addEventListener('change', renderStartState)

    // The install opt-in (decision A9): on by default, because an agent asked
    // to run a project's tests needs its dependencies, and the guest's own
    // shell is off the network so it cannot fetch them itself. The hint names
    // the one origin this admits.
    const installOptIn = el('input', {
      type: 'checkbox',
      class: 'container-run-install',
      name: 'containerRunInstall',
      checked: '',
    })
    const installField = el(
      'div',
      { class: 'container-run-install-field' },
      el(
        'label',
        { class: 'container-run-install-label' },
        installOptIn,
        el('span', {}, 'Install dependencies before the run'),
      ),
      el(
        'p',
        { class: 'field-hint container-run-install-hint' },
        "Runs the checkout's lockfile install (pnpm or npm) once, before the agent starts, so tests and builds " +
          'can run. The container can then also reach registry.npmjs.org and GitHub, anonymously — it holds no ' +
          'GitHub credential. The agent’s own commands stay off the network.',
      ),
    )

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
    function renderStartState(): void {
      const blocker = startBlocker({
        task: task.value,
        model: chosenModel,
        verdict: verdicts.get(chosenModel),
        rosterLoaded,
        loginChecked: loginOptIn.checked,
      })
      start.disabled = blocker !== null
      start.title = blocker ?? ''
    }
    renderStartState()
    task.addEventListener('input', renderStartState)
    start.addEventListener('click', () => {
      const threadId = context.getActiveThreadId()
      const projectId = context.getActiveProjectId()
      if (!threadId || !projectId) return
      const prompt = task.value.trim()
      if (!prompt) return
      // Remembered for "Run again" when the composer has moved on since.
      lastPrompt = prompt
      const wallClockMs = Math.max(1, Number(minutes.value) || DEFAULT_WALL_CLOCK_MINUTES) * 60_000
      const tokenCeiling = Math.max(1000, Number(tokens.value) || DEFAULT_TOKEN_CEILING)
      start.disabled = true
      void startRun({
        projectId,
        threadId,
        prompt,
        model: chosenModel,
        budgets: { wallClockMs, tokenCeiling },
        ...(loginOffer() !== null && loginOptIn.checked ? { useAgentLogin: true } : {}),
        installDependencies: installOptIn.checked,
      }).then((started) => {
        if (!started) start.disabled = false
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
      uiField({
        label: quotesDraft ? 'Task (from the composer)' : 'Task',
        control: task,
        ...(quotesDraft
          ? {}
          : { hint: 'Nothing in the composer to run — describe the task here.' }),
      }),
      modelField,
      agentNote,
      el(
        'div',
        { class: 'container-run-budgets' },
        uiField({ label: 'Stop after (minutes)', control: minutes }),
        uiField({ label: 'Token ceiling', control: tokens }),
      ),
      egressHint,
      loginField,
      installField,
      uiActions(cancel, start, { className: 'container-run-actions' }),
    )
  }

  function statusView(run: ContainerRunProgress): HTMLElement {
    const result = run.record?.result ?? null
    const rows: HTMLElement[] = []
    const row = (label: string, value: string): HTMLElement =>
      el('div', { class: 'container-run-row' }, el('dt', {}, label), el('dd', {}, value))
    rows.push(row('Phase', PHASE_LABEL[run.phase]))
    // What was asked. The dialog no longer holds the task while the run is in
    // flight, and reviewing what an unwatched run did means little without it.
    if (run.prompt) rows.push(row('Task', run.prompt))
    rows.push(row('Model', run.model))
    if (run.checkout) {
      rows.push(
        row(
          'Checkout',
          (run.checkout.mode === 'worktree' ? 'thread worktree' : 'project checkout') +
            (run.checkout.branch ? ` (${run.checkout.branch})` : ''),
        ),
      )
    }
    rows.push(row('Reachable origins', run.egressAllowlist.join(', ') || 'none'))
    // What the guest held to authenticate. A sign-in carried in is the one
    // case where the run had more than a scoped key, so it is never elided.
    const held = run.record?.credential ?? run.credential
    rows.push(
      row(
        'Credential',
        typeof held === 'object'
          ? `your desktop sign-in, copied in for the run (${held.login.map((d) => `~/${d}`).join(', ')})`
          : held === 'key'
            ? 'one API key, scoped to the run'
            : held === 'login'
              ? 'your desktop sign-in, copied in for the run'
              : 'none',
      ),
    )
    const elapsedRow = row('Elapsed', elapsedLabel(run))
    elapsedRow.querySelector('dd')?.classList.add('container-run-elapsed')
    rows.push(elapsedRow)
    if (run.record) {
      rows.push(row('Image', run.record.imageDigest?.slice(0, 19) ?? run.record.image))
      rows.push(
        row(
          'Containment',
          [
            'read-only rootfs, no capabilities',
            run.record.attestation.securityProfiles === 'default'
              ? 'default seccomp and AppArmor'
              : null,
            run.record.attestation.network === 'brokered' ? 'brokered egress' : 'no network',
            run.record.attestation.perCommandNetwork === 'token-gated'
              ? 'shell commands off the network'
              : null,
          ]
            .filter((part) => part !== null)
            .join(', '),
        ),
      )
      rows.push(row('Secret canary', run.record.secretCanary.present ? 'PRESENT' : 'absent'))
      rows.push(row('Teardown', run.record.teardown))
    }
    if (result) {
      rows.push(row('Outcome', result.stopReason))
      // Who ran the loop. Under an agent the deferral guarantee does not hold
      // — its outward effects were refused, not queued — so the record must
      // say which harness it is describing before anyone reads the counts.
      rows.push(
        row(
          'Harness',
          result.harness === 'copse'
            ? 'Copse'
            : `${findAcpCatalogEntry(result.harness.acp)?.title ?? result.harness.acp} (ACP agent)`,
        ),
      )
      rows.push(row('Prompts reached a handler', String(result.promptsAttempted)))
      rows.push(row('Effects refused', String(result.denials.length)))
      rows.push(
        row(
          'Tokens',
          `${String(result.usage.inputTokens)} in / ${String(result.usage.outputTokens)} out`,
        ),
      )
      rows.push(
        row(
          'Commits',
          run.record?.carryOut.ref ??
            (run.record?.carryOut.expected === true
              ? `NOT FETCHED — ${run.record.carryOut.error ?? 'unknown error'}`
              : 'none'),
        ),
      )
    }
    if (run.error) rows.push(row('Error', run.error))

    const sections: HTMLElement[] = [
      el('h2', { class: 'container-run-title' }, 'Unattended container run'),
      el('dl', { class: 'container-run-summary' }, ...rows),
    ]
    if (run.warnings.length > 0) {
      sections.push(
        el(
          'section',
          { class: 'container-run-section container-run-warnings' },
          el('h3', {}, 'Needs your attention'),
          el('ul', {}, ...run.warnings.map((warning) => el('li', {}, warning))),
        ),
      )
    }
    // What the guest reached and what it was refused, from the broker's own
    // log. The refusals matter most: a "completed" run with an agent that
    // reached nothing has its reason here and nowhere else.
    if (run.record && run.record.egress.length > 0) {
      const connects = new Map<string, number>()
      const refusals: string[] = []
      for (const entry of run.record.egress) {
        if (entry.event === 'connect')
          connects.set(entry.origin, (connects.get(entry.origin) ?? 0) + 1)
        if (entry.event === 'refused' || entry.event === 'error') {
          refusals.push(
            `${entry.origin}: ${entry.event}${entry.detail ? ` — ${entry.detail}` : ''}`,
          )
        }
      }
      sections.push(
        el(
          'section',
          { class: 'container-run-section container-run-egress' },
          el('h3', {}, 'Egress'),
          el(
            'ul',
            {},
            ...[...connects].map(([origin, count]) =>
              el(
                'li',
                { class: 'mono' },
                `${origin} — ${String(count)} connection${count === 1 ? '' : 's'}`,
              ),
            ),
            ...[...new Set(refusals)].map((line) =>
              el('li', { class: 'mono container-run-egress-refused' }, line),
            ),
          ),
        ),
      )
    }
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
    if (result && result.denials.length > 0) {
      sections.push(
        el(
          'section',
          { class: 'container-run-section container-run-denials' },
          el('h3', {}, `Refused by the container policy (${String(result.denials.length)})`),
          el(
            'ul',
            {},
            ...result.denials.map((entry) =>
              el(
                'li',
                {},
                el('strong', {}, entry.subject),
                entry.reasons.length > 0 ? ` — ${entry.reasons.join('; ')}` : '',
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
          el(
            'h3',
            {},
            run.record?.carryOut.ref === null || run.record?.carryOut.ref === undefined
              ? 'Commits the guest made (not fetched)'
              : `Commits on ${run.record.carryOut.ref}`,
          ),
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
    if (isLive(run)) {
      // The run belongs to the main process, not this window: closing hides
      // it, stopping is its own action, and the difference is said out loud.
      const stop = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-danger container-run-stop' },
        'Stop run',
      )
      stop.addEventListener('click', () => {
        stop.disabled = true
        void api.container
          .stopRun(run.threadId)
          .then((progress) => {
            if (progress) update(progress)
          })
          .catch((error: unknown) => {
            stop.disabled = false
            showErrorToast('Could not stop the container run', error)
          })
      })
      actions.push(stop)
      sections.push(
        el(
          'p',
          { class: 'field-hint container-run-close-hint' },
          'Closing this window does not stop the run; it keeps going until it finishes, hits its budget, or you stop it.',
        ),
      )
    }
    if (!isLive(run) && run.record?.carryOut.ref && (result?.commits.length ?? 0) > 0) {
      // The follow-up (A13): the guest's commits onto this thread's checkout,
      // so the next attended turn starts from them.
      const apply = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary container-run-apply' },
        `Apply ${String(result?.commits.length ?? 0)} commit${result?.commits.length === 1 ? '' : 's'} to this checkout`,
      )
      apply.addEventListener('click', () => {
        apply.disabled = true
        void adopt(run.record?.runtimeId ?? '', null).finally(() => {
          apply.disabled = false
        })
      })
      actions.push(apply)
    }
    if (!isLive(run)) {
      const again = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-primary container-run-again' },
        'Start another run',
      )
      again.addEventListener('click', () => {
        // Carry the task forward before the run is dropped: another run of the
        // same thread is usually the same task again, and with the composer
        // empty the form would otherwise open blank.
        lastPrompt = run.prompt
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
  /**
   * Start a run as a turn on the thread (A13, A14): the task becomes a user
   * message, the composer empties, the dialog closes and the banner takes
   * over. The card follows from the first progress snapshot. A start the
   * main process refuses leaves the message in place with the refusal in a
   * toast — what was asked is still worth the thread remembering.
   */
  async function startRun(request: ContainerRunRequest): Promise<boolean> {
    addMessage(context.store, request.threadId, 'user', request.prompt)
    context.clearDraft()
    try {
      const progress = await api.container.runThread(request)
      update(progress)
      overlay?.close()
      return true
    } catch (error) {
      showErrorToast('Could not start the container run', error)
      return false
    }
  }

  const DEFAULT_BUDGETS = {
    wallClockMs: DEFAULT_WALL_CLOCK_MINUTES * 60_000,
    tokenCeiling: DEFAULT_TOKEN_CEILING,
  }

  function latestOnActiveThread(): LatestContainerRun | null {
    const threadId = context.getActiveThreadId()
    const thread = threadId ? getThreadById(context.store, threadId) : undefined
    return thread ? latestContainerRun(thread) : null
  }

  function followUpTarget(): ContainerFollowUpTarget {
    const latest = latestOnActiveThread()
    const live = isLive(activeRun())
    if (!latest && !live) return { available: false, live: false, defaultToContainer: false }
    return {
      available: true,
      live,
      defaultToContainer:
        !live && latest !== null && latest.isLastTurn && latest.runtimeId !== null,
    }
  }

  /**
   * A follow-up sent to the container (A14): a new run that carries in the
   * latest run's commits and is told what that run was asked and reported,
   * on the same model and credential. The guest is a fresh process; the
   * continuity is the checkout and the prompt.
   */
  async function followUp(prompt: string): Promise<boolean> {
    const threadId = context.getActiveThreadId()
    const projectId = context.getActiveProjectId()
    if (!threadId || !projectId) return false
    if (isLive(activeRun())) {
      showToast('The container is still busy with the previous run; wait for it or stop it.', {
        variant: 'error',
      })
      return false
    }
    const latest = latestOnActiveThread()
    if (!latest || latest.runtimeId === null) {
      showToast('This thread has no container run to continue.', { variant: 'error' })
      return false
    }
    return startRun({
      projectId,
      threadId,
      prompt,
      model: latest.model,
      budgets: DEFAULT_BUDGETS,
      ...(latest.credential === 'login' ? { useAgentLogin: true } : {}),
      installDependencies: true,
      continueFrom: latest.runtimeId,
    })
  }

  /** Runs whose usage has been folded into the thread, so a re-sync never counts twice. */
  const usageFolded = new Set<string>()

  /**
   * What a finished agent turn does, done for a finished run: the thread is
   * marked unread when it is not on screen, the app's own alert goes out (a
   * notification when the window is hidden, the dock bounce and the sound the
   * user chose), and the run's tokens join the thread's usage. The first
   * real run finished invisibly for a user looking at another tab.
   */
  function settle(progress: ContainerRunProgress): void {
    const thread = getThreadById(context.store, progress.threadId)
    const usage = progress.record?.result?.usage
    if (usage && progress.runtimeId !== null && !usageFolded.has(progress.runtimeId)) {
      usageFolded.add(progress.runtimeId)
      addUsageDelta(context.store, progress.threadId, {
        model: progress.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    }
    markThreadUnread(context.store, progress.threadId)
    void api.alerts
      .threadFinished(progress.threadId, thread?.title ?? 'Container run')
      .catch((error: unknown) => {
        console.error('[container-run] could not signal the finished run:', error)
      })
  }

  /**
   * Apply a finished run's commits to the thread's checkout and say so on
   * the card. `toolCallId` is the card that asked, when one did; the dialog's
   * button finds the card by the run instead.
   */
  async function adopt(runtimeId: string, toolCallId: string | null): Promise<void> {
    const threadId = context.getActiveThreadId()
    const projectId = context.getActiveProjectId()
    if (!threadId || !projectId || runtimeId.length === 0) return
    try {
      const adoption = await api.container.adoptRun(projectId, threadId, runtimeId)
      const run = runs.get(threadId)
      const cardId =
        toolCallId ?? (run && run.runtimeId === runtimeId ? containerRunToolCallId(run) : null)
      if (cardId !== null) noteAdoptionOnCard(context.store, threadId, cardId, adoption)
      showToast(
        adoption.applied.length === 0
          ? `All ${String(adoption.alreadyApplied)} commit(s) from the run are already in this checkout.`
          : `Applied ${String(adoption.applied.length)} commit(s) from the run to this checkout.`,
        { variant: 'info', durationMs: 8_000 },
      )
    } catch (error) {
      showErrorToast("Could not apply the run's commits", error)
    }
  }
  const onCardAdopt = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return
    const detail: unknown = event.detail
    if (!isRecord(detail)) return
    const runtimeId = detail['runtimeId']
    const toolCallId = detail['toolCallId']
    if (typeof runtimeId !== 'string' || typeof toolCallId !== 'string') return
    void adopt(runtimeId, toolCallId)
  }
  document.addEventListener(CONTAINER_RUN_ADOPT_EVENT, onCardAdopt)

  function update(progress: ContainerRunProgress): void {
    const previous = runs.get(progress.threadId)
    runs.set(progress.threadId, progress)
    // The thread keeps the run as a card; a thread not in memory gets it when
    // it is next shown (see refresh).
    syncContainerRunCard(context.store, progress)
    if (previous && isLive(previous) && !isLive(progress)) {
      settle(progress)
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
        if (progress) {
          runs.set(threadId, progress)
          syncContainerRunCard(context.store, progress)
        }
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
    followUpTarget,
    followUp,
    destroy: (): void => {
      unsubscribe()
      document.removeEventListener(CONTAINER_RUN_ADOPT_EVENT, onCardAdopt)
      stopElapsedClock()
      modelPicker?.destroy()
      modelPicker = null
      overlay?.dialog.remove()
      overlay = null
    },
  }
}
