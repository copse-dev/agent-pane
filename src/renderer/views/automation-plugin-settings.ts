import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type {
  AutomationLiveWorktreeLimit,
  AutomationSchedule,
  AutomationScheduleInput,
} from '@shared/types'
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
import { ipcErrorMessage } from '../ipc-error-message.ts'

function cleanIpcError(error: unknown): string {
  return ipcErrorMessage(error, 'Automation request failed.')
}

function lastRunLabel(timestamp: number | undefined): string {
  if (timestamp === undefined) return 'Never run'
  return `Last started ${new Date(timestamp).toLocaleString()}`
}

function liveWorktreeLimit(value: string): AutomationLiveWorktreeLimit {
  if (value === '2') return 2
  if (value === '3') return 3
  return 1
}

type SimpleSchedule =
  | { repeat: 'daily'; hour: number; minute: number }
  | { repeat: 'weekdays'; hour: number; minute: number }
  | { repeat: 'weekly'; hour: number; minute: number; on: number }
  | { repeat: 'monthly'; hour: number; minute: number; on: number }

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

function parseCronNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}

/** Convert the common schedules offered by the editor from their stored cron form. */
function parseSimpleSchedule(cron: string): SimpleSchedule | null {
  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek, ...extra] = cron.trim().split(/\s+/)
  if (
    minuteRaw === undefined ||
    hourRaw === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined ||
    extra.length > 0 ||
    month !== '*'
  ) {
    return null
  }
  const minute = parseCronNumber(minuteRaw, 0, 59)
  const hour = parseCronNumber(hourRaw, 0, 23)
  if (minute === null || hour === null) return null

  if (dayOfMonth === '*' && dayOfWeek === '*') return { repeat: 'daily', hour, minute }
  if (dayOfMonth === '*' && dayOfWeek === '1-5') {
    return { repeat: 'weekdays', hour, minute }
  }
  if (dayOfMonth === '*') {
    const weekday = parseCronNumber(dayOfWeek, 0, 7)
    if (weekday !== null) return { repeat: 'weekly', hour, minute, on: weekday % 7 }
  }
  if (dayOfWeek === '*') {
    const monthDay = parseCronNumber(dayOfMonth, 1, 31)
    if (monthDay !== null) return { repeat: 'monthly', hour, minute, on: monthDay }
  }
  return null
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

function scheduleTime(schedule: SimpleSchedule): string {
  return `${twoDigits(schedule.hour)}:${twoDigits(schedule.minute)}`
}

function ordinal(value: number): string {
  const finalTwo = value % 100
  if (finalTwo >= 11 && finalTwo <= 13) return `${String(value)}th`
  if (value % 10 === 1) return `${String(value)}st`
  if (value % 10 === 2) return `${String(value)}nd`
  if (value % 10 === 3) return `${String(value)}rd`
  return `${String(value)}th`
}

function weekdayName(value: number): string {
  if (value === 0) return 'Sunday'
  if (value === 1) return 'Monday'
  if (value === 2) return 'Tuesday'
  if (value === 3) return 'Wednesday'
  if (value === 4) return 'Thursday'
  if (value === 5) return 'Friday'
  return 'Saturday'
}

function simpleScheduleDescription(schedule: SimpleSchedule): string {
  const time = scheduleTime(schedule)
  if (schedule.repeat === 'daily') return `Every day at ${time}`
  if (schedule.repeat === 'weekdays') return `Every weekday at ${time}`
  if (schedule.repeat === 'weekly') {
    return `Every ${weekdayName(schedule.on)} at ${time}`
  }
  return `On the ${ordinal(schedule.on)} of every month at ${time}`
}

function scheduleDescription(cron: string): string {
  const schedule = parseSimpleSchedule(cron)
  return schedule ? simpleScheduleDescription(schedule) : 'Custom schedule'
}

export interface AutomationEditor extends HTMLElement {
  setPluginEnabled: (enabled: boolean) => void
}

/**
 * First-party level-3 `settings-plugin-detail` view for copse.automations.
 * The plugin declares the slot; this shipped renderer supplies the executable UI
 * that a user-trust plugin is intentionally not allowed to inject.
 *
 * `revealScheduleId` is the schedule a sidebar automation heading linked to: it
 * opens for editing as soon as the list loads, so the click lands on that
 * schedule's setup rather than on the list it sits in.
 */
export function createAutomationPluginSettings(
  store: AppStore,
  api: ModelOptionsApi & Pick<ApiClient, 'automations'>,
  pluginEnabled: boolean,
  revealScheduleId?: string,
  createNew = false,
  projectId = store.getState().activeProjectId,
): AutomationEditor {
  const root = el('section', {
    class: 'automation-plugin-settings',
    'data-plugin-detail': AUTOMATIONS_PLUGIN_ID,
  })
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
  const pluginNotice = (): string =>
    pluginEnabled
      ? 'Each run starts a fresh isolated task. Runs group under the schedule name. One live worktree is the safe default; schedules can explicitly allow up to three. Normal tool permission prompts still apply.'
      : 'Enable this plugin to arm schedules. Existing schedules remain editable while disabled.'
  const notice = el('p', { class: 'automation-notice' }, pluginNotice())
  const status = el('div', { class: 'automation-status', role: 'status', hidden: true })
  const list = el('div', { class: 'automation-list' })

  const form = el('form', { class: 'automation-form', hidden: true })
  const formTitle = el('h3', { class: 'automation-form-title' }, 'New automation')
  const nameInput = el('input', {
    type: 'text',
    class: 'automation-input automation-name-input',
    placeholder: 'Nightly test review',
    maxlength: '160',
    required: true,
  })
  const repeatSelect = el(
    'select',
    { class: 'automation-input automation-repeat-select', required: true },
    el('option', { value: 'daily' }, 'Every day'),
    el('option', { value: 'weekdays' }, 'Weekdays'),
    el('option', { value: 'weekly' }, 'Every week'),
    el('option', { value: 'monthly' }, 'Every month'),
  )
  const timeInput = el('input', {
    type: 'time',
    class: 'automation-input automation-time-input',
    value: '09:00',
    required: true,
  })
  const weeklyDaySelect = el('select', {
    class: 'automation-input automation-weekly-day-select',
  })
  WEEKDAYS.forEach((day, index) => {
    weeklyDaySelect.append(el('option', { value: String(index) }, day))
  })
  const monthlyDaySelect = el('select', {
    class: 'automation-input automation-monthly-day-select',
  })
  for (let day = 1; day <= 31; day += 1) {
    monthlyDaySelect.append(el('option', { value: String(day) }, ordinal(day)))
  }
  const repeatLabel = el('label', { class: 'automation-label' }, 'Repeat', repeatSelect)
  const timeLabel = el('label', { class: 'automation-label' }, 'At', timeInput)
  const weeklyDayLabel = el(
    'label',
    { class: 'automation-label automation-weekly-day-label' },
    'On',
    weeklyDaySelect,
  )
  const monthlyDayLabel = el(
    'label',
    { class: 'automation-label automation-monthly-day-label' },
    'On day',
    monthlyDaySelect,
  )
  const scheduleSummary = el('span', {
    class: 'automation-hint automation-schedule-summary',
    'aria-live': 'polite',
  })
  const scheduleFields = el(
    'fieldset',
    { class: 'automation-schedule-fields' },
    el('legend', {}, 'Schedule'),
    el(
      'div',
      { class: 'automation-schedule-controls' },
      repeatLabel,
      weeklyDayLabel,
      monthlyDayLabel,
      timeLabel,
    ),
    scheduleSummary,
  )
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
  const worktreeLimitSelect = el(
    'select',
    { class: 'automation-input automation-worktree-limit-select' },
    el('option', { value: '1' }, '1 — wait for prior work'),
    el('option', { value: '2' }, '2 — allow one retained checkout'),
    el('option', { value: '3' }, '3 — allow two retained checkouts'),
  )
  const saveButton = el('button', { type: 'submit', class: 'automation-save-btn' }, 'Save schedule')
  const cancelButton = el('button', { type: 'button', class: 'automation-cancel-btn' }, 'Cancel')
  form.append(
    formTitle,
    el('label', { class: 'automation-label' }, 'Name', nameInput),
    el('label', { class: 'automation-label' }, 'Model', modelSelect),
    scheduleFields,
    el('label', { class: 'automation-label' }, 'Prompt', promptInput),
    el(
      'label',
      { class: 'automation-label automation-worktree-limit-label' },
      'Maximum live worktrees',
      worktreeLimitSelect,
      el(
        'span',
        { class: 'automation-hint' },
        'Higher limits let fresh runs start while older changes wait for review.',
      ),
    ),
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
  let customCron: string | null = null
  // Consumed by the first successful load; later refreshes (a save, a delete)
  // must not re-open the editor behind the user.
  let pendingReveal = revealScheduleId
  let pendingCreate = createNew

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
    list.hidden = false
    heading.hidden = false
  }

  function selectedSimpleSchedule(): SimpleSchedule | null {
    const [hourRaw, minuteRaw] = timeInput.value.split(':')
    if (hourRaw === undefined || minuteRaw === undefined) return null
    const hour = parseCronNumber(hourRaw, 0, 23)
    const minute = parseCronNumber(minuteRaw, 0, 59)
    if (hour === null || minute === null) return null
    if (repeatSelect.value === 'daily') return { repeat: 'daily', hour, minute }
    if (repeatSelect.value === 'weekdays') return { repeat: 'weekdays', hour, minute }
    if (repeatSelect.value === 'weekly') {
      const on = parseCronNumber(weeklyDaySelect.value, 0, 6)
      return on === null ? null : { repeat: 'weekly', hour, minute, on }
    }
    if (repeatSelect.value === 'monthly') {
      const on = parseCronNumber(monthlyDaySelect.value, 1, 31)
      return on === null ? null : { repeat: 'monthly', hour, minute, on }
    }
    return null
  }

  function cronFromScheduleControls(): string | null {
    const schedule = selectedSimpleSchedule()
    if (!schedule) {
      if (repeatSelect.value === 'custom' && customCron) return customCron
      return null
    }
    const prefix = `${String(schedule.minute)} ${String(schedule.hour)}`
    if (schedule.repeat === 'daily') return `${prefix} * * *`
    if (schedule.repeat === 'weekdays') return `${prefix} * * 1-5`
    if (schedule.repeat === 'weekly') return `${prefix} * * ${String(schedule.on)}`
    return `${prefix} ${String(schedule.on)} * *`
  }

  function updateScheduleControls(): void {
    const custom = repeatSelect.value === 'custom'
    const weekly = repeatSelect.value === 'weekly'
    const monthly = repeatSelect.value === 'monthly'
    timeLabel.hidden = custom
    timeInput.disabled = custom
    timeInput.required = !custom
    weeklyDayLabel.hidden = !weekly
    weeklyDaySelect.disabled = !weekly
    weeklyDaySelect.required = weekly
    monthlyDayLabel.hidden = !monthly
    monthlyDaySelect.disabled = !monthly
    monthlyDaySelect.required = monthly
    const schedule = selectedSimpleSchedule()
    scheduleSummary.textContent = custom
      ? 'This automation has an older custom schedule. Choose a repeat pattern to replace it.'
      : schedule
        ? `${simpleScheduleDescription(schedule)} · local time`
        : 'Choose when this automation should run.'
  }

  function setScheduleControls(cron: string): void {
    repeatSelect.querySelector('option[value="custom"]')?.remove()
    const schedule = parseSimpleSchedule(cron)
    customCron = schedule ? null : cron
    if (!schedule) {
      repeatSelect.append(el('option', { value: 'custom' }, 'Keep existing custom schedule'))
      repeatSelect.value = 'custom'
      updateScheduleControls()
      return
    }
    repeatSelect.value = schedule.repeat
    timeInput.value = scheduleTime(schedule)
    if (schedule.repeat === 'weekly') weeklyDaySelect.value = String(schedule.on)
    if (schedule.repeat === 'monthly') monthlyDaySelect.value = String(schedule.on)
    updateScheduleControls()
  }

  async function openForm(schedule?: AutomationSchedule): Promise<void> {
    hideStatus()
    editingId = schedule?.id ?? null
    formTitle.textContent = schedule ? 'Edit automation' : 'New automation'
    list.hidden = true
    heading.hidden = true
    nameInput.value = schedule?.name ?? ''
    setScheduleControls(schedule?.cron ?? '0 9 * * 1-5')
    promptInput.value = schedule?.prompt ?? ''
    enabledInput.checked = schedule?.enabled ?? true
    worktreeLimitSelect.value = String(schedule?.maxLiveWorktrees ?? 1)
    // An existing schedule keeps whatever it stored (including a model pinned
    // before schedules moved to dynamic selection — the picker surfaces it as a
    // pinned row). A new one starts from best value rather than inheriting the
    // chat model, since the chat model is a choice about right now.
    const configuredModel = schedule?.model.trim() ?? ''
    const defaultModel = configuredModel || BEST_VALUE_CHAT_MODEL
    form.hidden = false
    nameInput.focus()
    const options = await fetchDynamicModelOptions(defaultModel)
    const selectedModel =
      options.find((option) => option.value === defaultModel && !option.disabled)?.value ??
      options.find((option) => option.value && !option.disabled)?.value ??
      ''
    await modelPicker.refresh(selectedModel)
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
          el('span', { class: 'automation-row-schedule' }, scheduleDescription(schedule.cron)),
          el('span', {}, modelDisplayLabel(schedule.model)),
          el('span', {}, schedule.enabled ? 'Armed' : 'Paused'),
          el(
            'span',
            {},
            `${String(schedule.maxLiveWorktrees ?? 1)} live worktree${(schedule.maxLiveWorktrees ?? 1) === 1 ? '' : 's'} max`,
          ),
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
          (event) => {
            showStatus(
              event.disposition === 'started'
                ? `Started “${schedule.name}”.`
                : event.coalescedReason === 'worktree-limit'
                  ? `“${schedule.name}” has reached its live worktree limit.`
                  : `“${schedule.name}” is already pending or running.`,
            )
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
        })
          .then(async (confirmed) => {
            if (!confirmed) return
            await api.automations.remove(projectId, schedule.id)
            if (editingId === schedule.id) closeForm()
            await refresh()
          })
          .catch((error: unknown) => {
            showStatus(cleanIpcError(error), true)
          })
      })
      actions.append(edit, run, remove)
      row.append(copy, actions)
      list.append(row)
    }
  }

  /**
   * Open the schedule a sidebar heading linked to. A schedule can be deleted
   * while its finished runs stay in the sidebar, so a link with nowhere to land
   * says so instead of silently showing the list.
   */
  function revealLinkedSchedule(): void {
    const scheduleId = pendingReveal
    if (!scheduleId) return
    pendingReveal = undefined
    const schedule = schedules.find((candidate) => candidate.id === scheduleId)
    if (!schedule) {
      showStatus('That automation is no longer scheduled. Its finished runs stay in the sidebar.')
      return
    }
    void openForm(schedule).then(() => {
      form.scrollIntoView({ block: 'center' })
    })
  }

  async function refresh(): Promise<void> {
    if (!projectId) return
    try {
      schedules = await api.automations.list(projectId)
      renderList()
      revealLinkedSchedule()
      if (pendingCreate) {
        pendingCreate = false
        await openForm()
      }
    } catch (error) {
      showStatus(cleanIpcError(error), true)
    }
  }

  addButton.addEventListener('click', () => void openForm())
  cancelButton.addEventListener('click', closeForm)
  repeatSelect.addEventListener('change', () => {
    if (repeatSelect.value !== 'custom') {
      repeatSelect.querySelector('option[value="custom"]')?.remove()
      customCron = null
    }
    updateScheduleControls()
  })
  timeInput.addEventListener('input', updateScheduleControls)
  weeklyDaySelect.addEventListener('change', updateScheduleControls)
  monthlyDaySelect.addEventListener('change', updateScheduleControls)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!projectId) return
    hideStatus()
    const cron = cronFromScheduleControls()
    if (cron === null) {
      showStatus('Choose a valid schedule before saving.', true)
      if (repeatSelect.value === 'custom') repeatSelect.focus()
      else timeInput.focus()
      return
    }
    saveButton.setAttribute('disabled', '')
    const input: AutomationScheduleInput = {
      ...(editingId ? { id: editingId } : {}),
      name: nameInput.value,
      cron,
      prompt: promptInput.value,
      model: modelSelect.value,
      enabled: enabledInput.checked,
      maxLiveWorktrees: liveWorktreeLimit(worktreeLimitSelect.value),
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
  return Object.assign(root, {
    setPluginEnabled(enabled: boolean): void {
      pluginEnabled = enabled
      notice.textContent = pluginNotice()
      renderList()
    },
  })
}
