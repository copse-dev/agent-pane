import type {
  BranchCiAutomation,
  BranchCiAutomationInput,
  EventAutomationTrigger,
  EventAutomationTriggerInput,
  EventDeliverySummary,
} from '@shared/types'
import { describeAutomationFailure } from '@shared/automation-failure.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { BEST_VALUE_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { el, clear } from '../dom/helpers.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import {
  fetchDynamicModelOptions,
  modelDisplayLabel,
  type ModelOptionsApi,
} from './model-options.ts'
import { mountModelSelectPicker } from './model-picker.ts'
import { showConfirmDialog } from './confirm-dialog.ts'

type EditorApi = ModelOptionsApi & Pick<ApiClient, 'automations'>

export interface AutomationCreationDraft {
  name: string
  prompt: string
  model: string
  enabled: boolean
  maxLiveWorktrees: 1 | 2 | 3
}

export interface BranchCiEditor {
  refresh(): Promise<void>
  reveal(id: string): boolean
  openNew(draft?: AutomationCreationDraft): Promise<void>
  hideForSchedule(): void
  showList(): void
  setPluginEnabled(value: boolean): void
}

export function mountBranchCiEditor(options: {
  root: HTMLElement
  heading: HTMLElement
  scheduleList: HTMLElement
  scheduleForm: HTMLElement
  projectId: string | null
  api: EditorApi
  pluginEnabled: boolean
  showStatus: (message: string, error?: boolean) => void
  hideStatus: () => void
  onScheduleSelected: (draft: AutomationCreationDraft) => void
  onChanged?: () => Promise<void>
  /** Open the task a failed or stalled run created. Absent where there is nowhere to navigate. */
  onOpenRun?: (threadId: string) => void
}): BranchCiEditor {
  const { root, heading, scheduleList, scheduleForm, projectId, api, showStatus, hideStatus } =
    options
  let pluginEnabled = options.pluginEnabled
  let definitions: BranchCiAutomation[] = []
  let editingId: string | null = null
  const section = el('section', { class: 'automation-list automation-ci-list' })
  const sectionHeading = el('div', { class: 'plugin-settings-heading' }, 'Event automations')
  const rows = el('div', { class: 'automation-list' })
  section.append(sectionHeading, rows)
  const fields: { kind: string; node: HTMLElement }[] = []
  /** A form row shown only for one trigger kind. */
  function field(kind: string, node: HTMLElement): HTMLElement {
    node.dataset['triggerField'] = kind
    fields.push({ kind, node })
    return node
  }
  const form = el('form', { class: 'automation-form automation-ci-form', hidden: true })
  const title = el('h4', { class: 'automation-form-title' }, 'New automation')
  const when = el(
    'select',
    { class: 'automation-input automation-when-select' },
    el('option', { value: 'schedule' }, 'On a schedule'),
    el('option', { value: 'github-ci-failed' }, 'When CI fails on a branch'),
    el('option', { value: 'github-pr-changed' }, 'When a pull request changes'),
    el('option', { value: 'github-issue-labeled' }, 'When an issue gets a label'),
  )
  const name = el('input', {
    type: 'text',
    class: 'automation-input automation-ci-name',
    required: true,
    maxlength: '160',
    placeholder: 'Investigate failing CI',
  })
  const branch = el('input', {
    type: 'text',
    class: 'automation-input automation-ci-branch',
    required: true,
    maxlength: '200',
    placeholder: 'main',
    autocomplete: 'off',
    spellcheck: false,
  })
  const pullRequest = el('input', {
    type: 'number',
    class: 'automation-input automation-ci-pull-request',
    min: '1',
    step: '1',
    placeholder: 'Any — watch the branch',
    autocomplete: 'off',
  })
  const checks = el('input', {
    type: 'text',
    class: 'automation-input automation-ci-checks',
    maxlength: '2000',
    placeholder: 'All workflows — or e.g. CI, Lint',
    autocomplete: 'off',
    spellcheck: false,
  })
  const baseBranch = el('input', {
    type: 'text',
    class: 'automation-input automation-pr-base',
    maxlength: '200',
    placeholder: 'main',
    autocomplete: 'off',
    spellcheck: false,
  })
  const transition = el(
    'select',
    { class: 'automation-input automation-pr-transition' },
    el('option', { value: 'ready-for-review' }, 'A draft becomes ready for review'),
    el('option', { value: 'new-commits' }, 'A ready pull request gets new commits'),
  )
  const label = el('input', {
    type: 'text',
    class: 'automation-input automation-issue-label',
    maxlength: '50',
    placeholder: 'needs-triage',
    autocomplete: 'off',
    spellcheck: false,
  })
  const model = el('select', { class: 'automation-input automation-ci-model', required: true })
  const prompt = el('textarea', {
    class: 'automation-input automation-ci-prompt',
    required: true,
    maxlength: '100000',
    placeholder: 'Investigate the failed CI run and report the cause…',
  })
  const worktrees = el(
    'select',
    { class: 'automation-input automation-ci-worktrees' },
    el('option', { value: '1' }, '1 — wait for prior work'),
    el('option', { value: '2' }, '2 — allow one retained checkout'),
    el('option', { value: '3' }, '3 — allow two retained checkouts'),
  )
  const enabled = el('input', { type: 'checkbox', class: 'automation-ci-enabled' })
  const matches = el('ul', { class: 'automation-ci-matches', hidden: true })
  const summary = el('p', { class: 'automation-hint automation-ci-summary' })
  const preview = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-secondary automation-ci-preview',
    },
    'Test match',
  )
  const save = el(
    'button',
    {
      type: 'submit',
      class: 'ui-btn ui-btn-primary automation-ci-save',
    },
    'Save automation',
  )
  const cancel = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-secondary automation-ci-cancel',
    },
    'Cancel',
  )
  form.append(
    title,
    el('label', { class: 'automation-label automation-trigger-label' }, 'When', when),
    el('label', { class: 'automation-label' }, 'Name', name),
    field('github-ci-failed', el('label', { class: 'automation-label' }, 'Branch', branch)),
    field(
      'github-ci-failed',
      el('label', { class: 'automation-label' }, 'Pull request (optional)', pullRequest),
    ),
    field(
      'github-ci-failed',
      el('label', { class: 'automation-label' }, 'Only these workflows (optional)', checks),
    ),
    field(
      'github-pr-changed',
      el('label', { class: 'automation-label' }, 'Base branch', baseBranch),
    ),
    field(
      'github-pr-changed',
      el('label', { class: 'automation-label' }, 'Fires when', transition),
    ),
    field('github-issue-labeled', el('label', { class: 'automation-label' }, 'Label', label)),
    el('label', { class: 'automation-label' }, 'Model', model),
    el('label', { class: 'automation-label' }, 'Task', prompt),
    el('label', { class: 'automation-label' }, 'Maximum live worktrees', worktrees),
    el('label', { class: 'automation-enabled-label' }, enabled, 'Automation enabled'),
    summary,
    matches,
    el('div', { class: 'automation-form-actions' }, preview, cancel, save),
  )
  root.append(section, form)
  const modelPicker = mountModelSelectPicker(model, {
    loadOptions: (current) => fetchDynamicModelOptions(current),
    ariaLabel: 'CI automation model',
    loadOnMount: false,
  })

  type TriggerKind = EventAutomationTrigger['kind']
  function currentKind(): TriggerKind {
    return when.value === 'github-pr-changed' || when.value === 'github-issue-labeled'
      ? when.value
      : 'github-ci-failed'
  }

  function splitChecks(): string[] {
    return checks.value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }

  /** The trigger exactly as the form currently describes it. */
  function readTrigger(): EventAutomationTriggerInput {
    const kind = currentKind()
    if (kind === 'github-pr-changed') {
      return {
        kind,
        baseBranch: baseBranch.value.trim(),
        transition: transition.value === 'new-commits' ? 'new-commits' : 'ready-for-review',
      }
    }
    if (kind === 'github-issue-labeled') return { kind, label: label.value.trim() }
    const selected = splitChecks()
    const number = Number.parseInt(pullRequest.value, 10)
    return {
      kind,
      ...(Number.isInteger(number) && number > 0
        ? { pullRequest: number }
        : { branch: branch.value.trim() }),
      ...(selected.length > 0 ? { checks: selected } : {}),
    }
  }

  function updateSummary(): void {
    const kind = currentKind()
    branch.required = kind === 'github-ci-failed' && pullRequest.value.trim() === ''
    for (const item of fields) item.node.hidden = item.kind !== kind
    if (kind === 'github-pr-changed') {
      const base = baseBranch.value.trim() || 'the base branch'
      summary.textContent =
        transition.value === 'new-commits'
          ? `When a ready pull request into ${base} gets new commits, review them. One task per pull request head; at most three runs per 24 hours.`
          : `When a draft pull request into ${base} becomes ready for review, review it. One task per pull request head; at most three runs per 24 hours.`
      return
    }
    if (kind === 'github-issue-labeled') {
      summary.textContent = `When an issue is labelled “${label.value.trim() || 'a label'}”, triage it. Removing and re-applying the label starts a new task; at most three runs per 24 hours.`
      return
    }
    const number = Number.parseInt(pullRequest.value, 10)
    const target =
      Number.isInteger(number) && number > 0
        ? `pull request #${String(number)}`
        : branch.value.trim() || 'this branch'
    const selected = splitChecks()
    const only = selected.length > 0 ? ` (only ${selected.join(', ')})` : ''
    summary.textContent = `When CI finishes with a failure on ${target}${only}, investigate it. One task per run attempt on the current head; at most three runs per 24 hours.`
  }
  for (const input of [branch, pullRequest, checks, baseBranch, label]) {
    input.addEventListener('input', updateSummary)
  }
  transition.addEventListener('change', updateSummary)

  function close(): void {
    editingId = null
    form.hidden = true
    heading.hidden = false
    scheduleList.hidden = false
    section.hidden = false
    matches.hidden = true
  }
  async function open(
    definition?: BranchCiAutomation,
    draft?: AutomationCreationDraft,
  ): Promise<void> {
    hideStatus()
    editingId = definition?.id ?? null
    title.textContent = definition ? 'Edit automation' : 'New automation'
    const trigger = definition?.trigger
    when.value = trigger?.kind ?? 'github-ci-failed'
    when.disabled = Boolean(definition)
    name.value = definition?.name ?? draft?.name ?? ''
    branch.value = trigger?.kind === 'github-ci-failed' ? trigger.branch : ''
    pullRequest.value =
      trigger?.kind === 'github-ci-failed' && trigger.pullRequest !== undefined
        ? String(trigger.pullRequest)
        : ''
    checks.value = trigger?.kind === 'github-ci-failed' ? (trigger.checks ?? []).join(', ') : ''
    baseBranch.value = trigger?.kind === 'github-pr-changed' ? trigger.baseBranch : ''
    transition.value =
      trigger?.kind === 'github-pr-changed' ? trigger.transition : 'ready-for-review'
    label.value = trigger?.kind === 'github-issue-labeled' ? trigger.label : ''
    prompt.value = definition?.prompt ?? draft?.prompt ?? ''
    worktrees.value = String(definition?.maxLiveWorktrees ?? draft?.maxLiveWorktrees ?? 1)
    enabled.checked = definition?.enabled ?? draft?.enabled ?? true
    matches.hidden = true
    updateSummary()
    heading.hidden = true
    scheduleList.hidden = true
    scheduleForm.hidden = true
    section.hidden = true
    form.hidden = false
    name.focus()
    const defaultModel = definition?.model ?? draft?.model ?? BEST_VALUE_CHAT_MODEL
    const available = await fetchDynamicModelOptions(defaultModel)
    const selected =
      available.find((item) => item.value === defaultModel && !item.disabled)?.value ??
      available.find((item) => item.value && !item.disabled)?.value ??
      ''
    await modelPicker.refresh(selected)
  }

  function triggerLabel(trigger: EventAutomationTrigger): string {
    if (trigger.kind === 'github-pr-changed') {
      return `${trigger.transition === 'new-commits' ? 'PR new commits' : 'PR ready for review'} · ${trigger.repository} · ${trigger.baseBranch}`
    }
    if (trigger.kind === 'github-issue-labeled') {
      return `Issue labelled · ${trigger.repository} · ${trigger.label}`
    }
    const scope =
      trigger.pullRequest !== undefined ? `PR #${String(trigger.pullRequest)}` : trigger.branch
    const only =
      trigger.checks && trigger.checks.length > 0 ? ` · ${trigger.checks.join(', ')}` : ''
    return `Failed CI · ${trigger.repository} · ${scope}${only}`
  }

  const OUTCOME_LABEL: Record<EventDeliverySummary['outcome'], string> = {
    started: 'Started',
    waiting: 'Waiting',
    filtered: 'Filtered out',
    held: 'Needs attention',
  }

  function renderDeliveries(
    target: HTMLElement,
    deliveries: readonly EventDeliverySummary[],
  ): void {
    clear(target)
    if (deliveries.length === 0) {
      target.append(el('p', { class: 'automation-empty' }, 'No deliveries yet.'))
      return
    }
    const listEl = el('ul', { class: 'automation-delivery-list' })
    for (const delivery of deliveries) {
      const item = el(
        'li',
        { class: 'automation-delivery', 'data-delivery-outcome': delivery.outcome },
        el('span', { class: 'automation-delivery-outcome' }, OUTCOME_LABEL[delivery.outcome]),
        el('span', { class: 'automation-delivery-summary' }, delivery.summary),
        el(
          'time',
          {
            class: 'automation-delivery-time',
            datetime: new Date(delivery.receivedAt).toISOString(),
          },
          new Date(delivery.receivedAt).toLocaleString(),
        ),
      )
      if (delivery.reason) {
        item.append(el('span', { class: 'automation-delivery-reason' }, delivery.reason))
      }
      if (delivery.threadId && options.onOpenRun) {
        const threadId = delivery.threadId
        const open = el(
          'button',
          { type: 'button', class: 'ui-btn ui-btn-ghost ui-btn-compact automation-delivery-open' },
          'Open task',
        )
        open.addEventListener('click', () => options.onOpenRun?.(threadId))
        item.append(open)
      }
      listEl.append(item)
    }
    target.append(listEl)
  }

  function problemBlock(definition: BranchCiAutomation): HTMLElement | null {
    const problem = definition.lastProblem
    if (!problem) return null
    const description = describeAutomationFailure(problem.code ?? 'unknown')
    // A problem with no run behind it is a failed poll, not a failed run: say so, and say it heals.
    const polling =
      problem.threadId === undefined && (problem.code === undefined || problem.code === 'unknown')
    const title = polling ? 'Could not check GitHub' : description.title
    const remedy = polling
      ? 'Copse retries every minute and clears this once GitHub can be read again.'
      : description.remedy
    const block = el(
      'div',
      {
        class: 'automation-row-blocked-message automation-row-problem-message',
        'data-failure-code': problem.code ?? 'unknown',
        role: 'status',
      },
      el('strong', { class: 'automation-problem-title' }, title),
      el(
        'span',
        { class: 'automation-problem-time' },
        ` · ${new Date(problem.at).toLocaleString()}`,
      ),
      el('div', { class: 'automation-problem-message' }, problem.message),
      el('div', { class: 'automation-problem-remedy' }, remedy),
    )
    const threadId = problem.threadId
    if (threadId && options.onOpenRun && description.action === 'open-run') {
      const open = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-secondary ui-btn-compact automation-problem-action',
        },
        description.actionLabel,
      )
      open.addEventListener('click', () => options.onOpenRun?.(threadId))
      block.append(open)
    } else if (
      description.action === 'open-automations' ||
      description.action === 'open-model-settings'
    ) {
      const edit = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-secondary ui-btn-compact automation-problem-action',
        },
        'Edit automation',
      )
      edit.addEventListener('click', () => void open(definition))
      block.append(edit)
    }
    return block
  }

  function render(): void {
    clear(rows)
    if (definitions.length === 0) {
      rows.append(
        el('p', { class: 'automation-empty' }, 'No event automations for this project yet.'),
      )
      return
    }
    for (const definition of definitions) {
      const row = el('article', {
        class: `automation-row${definition.enabled ? '' : ' automation-row-paused'}${definition.lastProblem ? ' automation-row-blocked' : ''}`,
        'data-ci-automation-id': definition.id,
        'data-trigger-kind': definition.trigger.kind,
      })
      const copy = el(
        'div',
        { class: 'automation-row-copy' },
        el('div', { class: 'automation-row-title' }, definition.name),
        el(
          'div',
          { class: 'automation-row-meta' },
          el('span', {}, triggerLabel(definition.trigger)),
          el('span', {}, modelDisplayLabel(definition.model)),
          el('span', {}, definition.enabled && pluginEnabled ? 'Armed' : 'Paused'),
        ),
        el(
          'div',
          { class: 'automation-row-last-run' },
          definition.lastRunAt
            ? `Last started ${new Date(definition.lastRunAt).toLocaleString()}`
            : 'Never run',
        ),
      )
      const problem = problemBlock(definition)
      if (problem) copy.append(problem)
      const history = el('details', { class: 'automation-deliveries' })
      const body = el('div', { class: 'automation-deliveries-body' })
      history.append(el('summary', {}, 'Recent deliveries'), body)
      history.addEventListener('toggle', () => {
        if (!history.open || !projectId) return
        body.textContent = 'Loading…'
        api.automations.eventHistory(projectId, definition.id).then(
          (deliveries) => {
            renderDeliveries(body, deliveries)
          },
          (error: unknown) => {
            body.textContent = ipcErrorMessage(error, 'Could not load deliveries.')
          },
        )
      })
      copy.append(history)
      const edit = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-secondary ui-btn-compact automation-row-btn',
        },
        'Edit',
      )
      edit.addEventListener('click', () => void open(definition))
      const remove = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-danger ui-btn-compact automation-row-btn',
        },
        'Delete',
      )
      remove.addEventListener('click', () => {
        if (!projectId) return
        void showConfirmDialog({
          message: `Delete “${definition.name}”?`,
          detail: 'Already-created tasks are kept.',
          confirmLabel: 'Delete automation',
          danger: true,
        })
          .then(async (confirmed) => {
            if (!confirmed) return
            await api.automations.removeBranchCi(projectId, definition.id)
            await refresh()
            await options.onChanged?.()
          })
          .catch((error: unknown) => {
            showStatus(ipcErrorMessage(error, 'Could not delete the automation.'), true)
          })
      })
      row.append(copy, el('div', { class: 'automation-row-actions' }, edit, remove))
      rows.append(row)
    }
  }
  async function refresh(): Promise<void> {
    if (!projectId) return
    definitions = await api.automations.listBranchCi(projectId)
    render()
  }
  when.addEventListener('change', () => {
    if (when.value === 'schedule' && !editingId) {
      options.onScheduleSelected({
        name: name.value,
        prompt: prompt.value,
        model: model.value || BEST_VALUE_CHAT_MODEL,
        enabled: enabled.checked,
        maxLiveWorktrees: worktrees.value === '3' ? 3 : worktrees.value === '2' ? 2 : 1,
      })
      return
    }
    matches.hidden = true
    updateSummary()
  })
  cancel.addEventListener('click', close)
  preview.addEventListener('click', () => {
    if (!projectId) return
    preview.disabled = true
    matches.hidden = true
    void api.automations
      .testBranchCi(projectId, readTrigger())
      .then(
        (result) => {
          clear(matches)
          for (const item of result.recent) matches.append(el('li', {}, item))
          matches.hidden = result.recent.length === 0
          const where = result.branch ? `${result.repository}/${result.branch}` : result.repository
          showStatus(
            result.recent.length > 0
              ? `Would have matched ${String(result.recent.length)} recent item${result.recent.length === 1 ? '' : 's'} on ${where}. Test match did not start a task.`
              : `Nothing recent on ${where} would match. Test match did not start a task.`,
          )
        },
        (error: unknown) => {
          showStatus(ipcErrorMessage(error, 'Could not check recent activity.'), true)
        },
      )
      .finally(() => {
        preview.disabled = false
      })
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!projectId) return
    hideStatus()
    save.disabled = true
    const input: BranchCiAutomationInput = {
      ...(editingId ? { id: editingId } : {}),
      name: name.value,
      trigger: readTrigger(),
      prompt: prompt.value,
      model: model.value,
      enabled: enabled.checked,
      maxLiveWorktrees: worktrees.value === '3' ? 3 : worktrees.value === '2' ? 2 : 1,
    }
    void api.automations
      .upsertBranchCi(projectId, input)
      .then(
        async () => {
          close()
          await refresh()
          await options.onChanged?.()
        },
        (error: unknown) => {
          showStatus(ipcErrorMessage(error, 'Could not save the automation.'), true)
        },
      )
      .finally(() => {
        save.disabled = false
      })
  })
  return {
    refresh,
    openNew(draft?: AutomationCreationDraft): Promise<void> {
      return open(undefined, draft)
    },
    reveal(id: string): boolean {
      const definition = definitions.find((candidate) => candidate.id === id)
      if (!definition) return false
      void open(definition)
      return true
    },
    hideForSchedule(): void {
      form.hidden = true
      section.hidden = true
    },
    showList(): void {
      form.hidden = true
      section.hidden = false
    },
    setPluginEnabled(value: boolean): void {
      pluginEnabled = value
      render()
    },
  }
}
