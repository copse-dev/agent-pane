import type { BranchCiAutomation, BranchCiAutomationInput } from '@shared/types'
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
}): BranchCiEditor {
  const { root, heading, scheduleList, scheduleForm, projectId, api, showStatus, hideStatus } =
    options
  let pluginEnabled = options.pluginEnabled
  let definitions: BranchCiAutomation[] = []
  let editingId: string | null = null
  const section = el('section', { class: 'automation-list automation-ci-list' })
  const sectionHeading = el('div', { class: 'plugin-settings-heading' }, 'CI events')
  const rows = el('div', { class: 'automation-list' })
  section.append(sectionHeading, rows)
  const form = el('form', { class: 'automation-form automation-ci-form', hidden: true })
  const title = el('h4', { class: 'automation-form-title' }, 'New automation')
  const when = el(
    'select',
    { class: 'automation-input automation-when-select' },
    el('option', { value: 'schedule' }, 'On a schedule'),
    el('option', { value: 'github-ci-failed' }, 'When CI fails on a branch'),
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
    el('label', { class: 'automation-label' }, 'Branch', branch),
    el('label', { class: 'automation-label' }, 'Model', model),
    el('label', { class: 'automation-label' }, 'Task', prompt),
    el('label', { class: 'automation-label' }, 'Maximum live worktrees', worktrees),
    el('label', { class: 'automation-enabled-label' }, enabled, 'CI event enabled'),
    summary,
    el('div', { class: 'automation-form-actions' }, preview, cancel, save),
  )
  root.append(section, form)
  const modelPicker = mountModelSelectPicker(model, {
    loadOptions: (current) => fetchDynamicModelOptions(current),
    ariaLabel: 'CI automation model',
    loadOnMount: false,
  })

  function updateSummary(): void {
    const selected = branch.value.trim() || 'this branch'
    summary.textContent = `When CI finishes with a failure on ${selected}, investigate it. One task per run attempt on the current branch head; at most three runs per 24 hours.`
  }
  branch.addEventListener('input', updateSummary)

  function close(): void {
    editingId = null
    form.hidden = true
    heading.hidden = false
    scheduleList.hidden = false
    section.hidden = false
  }
  async function open(
    definition?: BranchCiAutomation,
    draft?: AutomationCreationDraft,
  ): Promise<void> {
    hideStatus()
    editingId = definition?.id ?? null
    title.textContent = definition ? 'Edit automation' : 'New automation'
    when.value = 'github-ci-failed'
    when.disabled = Boolean(definition)
    name.value = definition?.name ?? draft?.name ?? ''
    branch.value = definition?.trigger.branch ?? ''
    prompt.value = definition?.prompt ?? draft?.prompt ?? ''
    worktrees.value = String(definition?.maxLiveWorktrees ?? draft?.maxLiveWorktrees ?? 1)
    enabled.checked = definition?.enabled ?? draft?.enabled ?? true
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

  function render(): void {
    clear(rows)
    if (definitions.length === 0) {
      rows.append(el('p', { class: 'automation-empty' }, 'No CI events for this project yet.'))
      return
    }
    for (const definition of definitions) {
      const row = el('article', {
        class: `automation-row${definition.enabled ? '' : ' automation-row-paused'}`,
        'data-ci-automation-id': definition.id,
      })
      const copy = el(
        'div',
        { class: 'automation-row-copy' },
        el('div', { class: 'automation-row-title' }, definition.name),
        el(
          'div',
          { class: 'automation-row-meta' },
          el(
            'span',
            {},
            `Failed CI · ${definition.trigger.repository} · ${definition.trigger.branch}`,
          ),
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
          confirmLabel: 'Delete CI event',
          danger: true,
        })
          .then(async (confirmed) => {
            if (!confirmed) return
            await api.automations.removeBranchCi(projectId, definition.id)
            await refresh()
          })
          .catch((error: unknown) => {
            showStatus(ipcErrorMessage(error, 'Could not delete CI event.'), true)
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
    if (when.value !== 'schedule' || editingId) return
    options.onScheduleSelected({
      name: name.value,
      prompt: prompt.value,
      model: model.value || BEST_VALUE_CHAT_MODEL,
      enabled: enabled.checked,
      maxLiveWorktrees: worktrees.value === '3' ? 3 : worktrees.value === '2' ? 2 : 1,
    })
  })
  cancel.addEventListener('click', close)
  preview.addEventListener('click', () => {
    if (!projectId || !branch.value.trim()) return
    preview.disabled = true
    void api.automations
      .testBranchCi(projectId, branch.value.trim())
      .then(
        (result) => {
          showStatus(
            result.latestFailure
              ? `Latest matching failure on ${result.repository}/${result.branch}: ${result.latestFailure}. Test match did not start a task.`
              : `No failed run on the current head of ${result.repository}/${result.branch}. Test match did not start a task.`,
          )
        },
        (error: unknown) => {
          showStatus(ipcErrorMessage(error, 'Could not check recent CI runs.'), true)
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
      branch: branch.value,
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
        },
        (error: unknown) => {
          showStatus(ipcErrorMessage(error, 'Could not save CI event.'), true)
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
