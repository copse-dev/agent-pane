import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { AutomationSchedule, AutomationScheduleInput } from '@shared/types'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { BEST_VALUE_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { el, clear } from '../dom/helpers.ts'
import {
  fetchDynamicModelOptions,
  modelDisplayLabel,
  type ModelOptionsApi,
} from './model-options.ts'
import { mountModelSelectPicker } from './model-picker.ts'
import { showConfirmDialog } from './confirm-dialog.ts'

function cleanIpcError(error: unknown): string {
  if (!(error instanceof Error)) return 'Automation request failed.'
  return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function lastRunLabel(timestamp: number | undefined): string {
  if (timestamp === undefined) return 'Never run'
  return `Last created ${new Date(timestamp).toLocaleString()}`
}

/**
 * First-party level-3 `settings-plugin-detail` view for copse.automations.
 * The plugin declares the slot; this shipped renderer supplies the executable UI
 * that a user-trust plugin is intentionally not allowed to inject.
 */
export function createAutomationPluginSettings(
  store: AppStore,
  api: ModelOptionsApi & Pick<ApiClient, 'automations'>,
  pluginEnabled: boolean,
): HTMLElement {
  const root = el('section', {
    class: 'automation-plugin-settings',
    'data-plugin-detail': AUTOMATIONS_PLUGIN_ID,
  })
  const projectId = store.getState().activeProjectId
  const project = store.getState().projects.find((candidate) => candidate.id === projectId)

  const heading = el('div', { class: 'automation-plugin-heading' })
  heading.append(
    el('div', { class: 'plugin-settings-heading' }, 'Schedules'),
    el(
      'button',
      {
        type: 'button',
        class: 'automation-add-btn',
        disabled: projectId ? undefined : true,
      },
      'Add schedule',
    ),
  )
  const addButton = heading.querySelector<HTMLButtonElement>('.automation-add-btn')
  if (!addButton) throw new Error('Automation add button did not mount')

  const scope = el(
    'p',
    { class: 'automation-scope' },
    project
      ? `Project: ${project.name} · local time · Copse must be running`
      : 'Open a project to configure its schedules.',
  )
  const notice = el(
    'p',
    { class: 'automation-notice' },
    pluginEnabled
      ? 'A match starts a task on whichever model the schedule’s rule picks at that moment. Normal tool permission prompts still apply.'
      : 'Enable this plugin to arm schedules. Existing schedules remain editable while disabled.',
  )
  const status = el('div', { class: 'automation-status', hidden: true })
  const list = el('div', { class: 'automation-list' })

  const form = el('form', { class: 'automation-form', hidden: true })
  const nameInput = el('input', {
    type: 'text',
    class: 'automation-input automation-name-input',
    placeholder: 'Nightly test review',
    maxlength: '160',
    required: true,
  })
  const cronInput = el('input', {
    type: 'text',
    class: 'automation-input automation-cron-input',
    placeholder: '0 9 * * 1-5',
    maxlength: '160',
    required: true,
    spellcheck: false,
  })
  const modelSelect = el('select', {
    class: 'automation-input automation-model-select',
    required: true,
  })
  const promptInput = el('textarea', {
    class: 'automation-input automation-prompt-input',
    placeholder: 'Review the project and prepare a concise status report…',
    maxlength: '100000',
    required: true,
  })
  const enabledInput = el('input', { type: 'checkbox', class: 'automation-enabled-input' })
  const saveButton = el('button', { type: 'submit', class: 'automation-save-btn' }, 'Save schedule')
  const cancelButton = el('button', { type: 'button', class: 'automation-cancel-btn' }, 'Cancel')
  form.append(
    el('label', { class: 'automation-label' }, 'Name', nameInput),
    el(
      'label',
      { class: 'automation-label' },
      'Cron',
      cronInput,
      el('span', { class: 'automation-hint' }, 'minute hour day month weekday'),
    ),
    el('label', { class: 'automation-label' }, 'Model', modelSelect),
    el('label', { class: 'automation-label' }, 'Prompt', promptInput),
    el('label', { class: 'automation-enabled-label' }, enabledInput, 'Schedule enabled'),
    el('div', { class: 'automation-form-actions' }, saveButton, cancelButton),
  )
  root.append(heading, scope, notice, status, list, form)
  // A schedule fires unattended, potentially months after it was written, so it
  // stores a rule rather than a model id — the same treatment every plugin-owned
  // model setting gets. The rule resolves when the task is created, against the
  // providers and plan windows that exist then.
  const modelPicker = mountModelSelectPicker(modelSelect, {
    loadOptions: (current) => fetchDynamicModelOptions(current),
    ariaLabel: 'Automation model',
    loadOnMount: false,
  })

  let schedules: AutomationSchedule[] = []
  let editingId: string | null = null

  function showStatus(message: string, error = false): void {
    status.hidden = false
    status.textContent = message
    status.classList.toggle('automation-status-error', error)
  }

  function hideStatus(): void {
    status.hidden = true
    status.textContent = ''
    status.classList.remove('automation-status-error')
  }

  function closeForm(): void {
    editingId = null
    form.hidden = true
  }

  async function openForm(schedule?: AutomationSchedule): Promise<void> {
    hideStatus()
    editingId = schedule?.id ?? null
    nameInput.value = schedule?.name ?? ''
    cronInput.value = schedule?.cron ?? '0 9 * * 1-5'
    promptInput.value = schedule?.prompt ?? ''
    enabledInput.checked = schedule?.enabled ?? true
    // An existing schedule keeps whatever it stored (including a model pinned
    // before schedules moved to dynamic selection — the picker surfaces it as a
    // pinned row). A new one starts from best value rather than inheriting the
    // chat model, since the chat model is a choice about right now.
    const configuredModel = schedule?.model.trim() ?? ''
    const defaultModel = configuredModel || BEST_VALUE_CHAT_MODEL
    const options = await fetchDynamicModelOptions(defaultModel)
    const selectedModel =
      options.find((option) => option.value === defaultModel && !option.disabled)?.value ??
      options.find((option) => option.value && !option.disabled)?.value ??
      ''
    await modelPicker.refresh(selectedModel)
    form.hidden = false
    nameInput.focus()
  }

  function renderList(): void {
    clear(list)
    if (!projectId) return
    if (schedules.length === 0) {
      list.append(el('div', { class: 'automation-empty' }, 'No schedules for this project yet.'))
      return
    }
    for (const schedule of schedules) {
      const row = el('article', {
        class: `automation-row${schedule.enabled ? '' : ' automation-row-paused'}`,
        'data-schedule-id': schedule.id,
      })
      const copy = el('div', { class: 'automation-row-copy' })
      copy.append(
        el('div', { class: 'automation-row-title' }, schedule.name),
        el(
          'div',
          { class: 'automation-row-meta' },
          el('code', {}, schedule.cron),
          el('span', {}, modelDisplayLabel(schedule.model)),
          el('span', {}, schedule.enabled ? 'Armed' : 'Paused'),
        ),
        el('div', { class: 'automation-row-last-run' }, lastRunLabel(schedule.lastRunAt)),
      )
      const actions = el('div', { class: 'automation-row-actions' })
      const edit = el('button', { type: 'button', class: 'automation-row-btn' }, 'Edit')
      const run = el(
        'button',
        {
          type: 'button',
          class: 'automation-row-btn automation-run-btn',
          disabled: pluginEnabled ? undefined : true,
          title: pluginEnabled ? 'Start a scheduled task now' : 'Enable the plugin to run',
        },
        'Run now',
      )
      const remove = el(
        'button',
        { type: 'button', class: 'automation-row-btn automation-remove-btn' },
        'Delete',
      )
      edit.addEventListener('click', () => void openForm(schedule))
      run.addEventListener('click', () => {
        run.disabled = true
        void api.automations.runNow(projectId, schedule.id).then(
          () => {
            showStatus(`Started “${schedule.name}”.`)
            void refresh()
          },
          (error: unknown) => {
            showStatus(cleanIpcError(error), true)
            run.disabled = !pluginEnabled
          },
        )
      })
      remove.addEventListener('click', () => {
        void showConfirmDialog({
          message: `Delete “${schedule.name}”?`,
          detail: 'Already-created tasks are not deleted.',
          confirmLabel: 'Delete schedule',
          danger: true,
        }).then(async (confirmed) => {
          if (!confirmed) return
          await api.automations.remove(projectId, schedule.id)
          if (editingId === schedule.id) closeForm()
          await refresh()
        })
      })
      actions.append(edit, run, remove)
      row.append(copy, actions)
      list.append(row)
    }
  }

  async function refresh(): Promise<void> {
    if (!projectId) return
    try {
      schedules = await api.automations.list(projectId)
      renderList()
    } catch (error) {
      showStatus(cleanIpcError(error), true)
    }
  }

  addButton.addEventListener('click', () => void openForm())
  cancelButton.addEventListener('click', closeForm)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!projectId) return
    hideStatus()
    saveButton.setAttribute('disabled', '')
    const input: AutomationScheduleInput = {
      ...(editingId ? { id: editingId } : {}),
      name: nameInput.value,
      cron: cronInput.value,
      prompt: promptInput.value,
      model: modelSelect.value,
      enabled: enabledInput.checked,
    }
    void api.automations
      .upsert(projectId, input)
      .then(
        async () => {
          closeForm()
          await refresh()
        },
        (error: unknown) => {
          showStatus(cleanIpcError(error), true)
        },
      )
      .finally(() => {
        saveButton.removeAttribute('disabled')
      })
  })

  void refresh()
  return root
}
