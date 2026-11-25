import type { ApiClient } from '../../../preload/api.d.ts'
import { REASONING_LEVELS, isReasoningLevel } from '@copse/llm/model-parameters.ts'
import {
  AGENT_PROFILE_INSTRUCTIONS_MAX,
  AGENT_PROFILE_NAME_MAX,
  AGENT_PROFILES_MAX,
  AGENT_PROFILES_SETTING,
  agentProfilesSchema,
  newAgentProfileId,
  type AgentProfile,
} from '@shared/agent-profiles.ts'
import { el, clear } from '../../dom/helpers.ts'
import { fetchModelOptions, modelDisplayLabel } from '../model-options.ts'
import { mountModelSelectPicker, type ModelSelectPicker } from '../model-picker.ts'

const EFFORT_LABELS: Record<(typeof REASONING_LEVELS)[number], string> = {
  off: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** Shown where a profile leaves the chat's model alone. */
const KEEP_MODEL_LABEL = 'Keep the chat’s model'

export interface AgentProfilesSection {
  root: HTMLFieldSetElement
  refresh: (signal?: AbortSignal) => Promise<void>
}

/**
 * Settings > Agent > Profiles: named setups (model, effort, instructions) a
 * chat can switch to from the composer's model menu. Each add, edit or removal
 * saves at once, like Settings' other lists, so the composer sees it next time
 * its menu opens.
 */
export function createAgentProfilesSection(
  api: ApiClient,
  opts: { onChanged?: () => void } = {},
): AgentProfilesSection {
  let profiles: AgentProfile[] = []
  /** The profile the form is editing; `null` while adding a new one. */
  let editingId: string | null = null

  const list = el('div', { class: 'agent-profile-list' })
  const status = el('p', { class: 'field-hint agent-profile-status', role: 'status' })
  status.hidden = true

  const nameInput = el('input', {
    type: 'text',
    class: 'agent-profile-name',
    maxlength: String(AGENT_PROFILE_NAME_MAX),
    placeholder: 'Reviewer',
    'aria-label': 'Profile name',
  })
  const modelSelect = el('select', { class: 'agent-profile-model', 'aria-label': 'Profile model' })
  modelSelect.append(el('option', { value: '' }, KEEP_MODEL_LABEL))
  const effortSelect = el(
    'select',
    { class: 'agent-profile-effort', 'aria-label': 'Profile effort' },
    el('option', { value: '' }, 'The model’s own level'),
    ...REASONING_LEVELS.map((level) => el('option', { value: level }, EFFORT_LABELS[level])),
  )
  const instructionsInput = el('textarea', {
    class: 'agent-profile-instructions',
    rows: '5',
    maxlength: String(AGENT_PROFILE_INSTRUCTIONS_MAX),
    placeholder: 'Review the diff for correctness first. Do not edit files unless asked.',
    'aria-label': 'Profile instructions',
  })
  const saveButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary agent-profile-save' },
    'Save profile',
  )
  const cancelButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary agent-profile-cancel' },
    'Cancel',
  )
  const formTitle = el('p', { class: 'agent-profile-form-title' })
  const form = el(
    'div',
    { class: 'agent-profile-form' },
    formTitle,
    el('label', {}, 'Name', nameInput),
    el('label', {}, 'Model', modelSelect),
    el('label', {}, 'Effort', effortSelect),
    el(
      'label',
      {},
      'Instructions',
      instructionsInput,
      el(
        'span',
        { class: 'field-hint' },
        'Added to every turn of a chat using this profile, after your custom instructions.',
      ),
    ),
    el('div', { class: 'provider-actions' }, saveButton, cancelButton),
  )
  form.hidden = true
  const addButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary agent-profile-add' },
    'Add profile',
  )

  const root = el(
    'fieldset',
    { class: 'agent-profiles' },
    el('legend', {}, 'Profiles'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Save a model, effort and instructions under a name, such as a reviewer or a bug hunter, ' +
        'then switch a chat to it from the model menu in the composer.',
    ),
    list,
    addButton,
    form,
    status,
  )

  let modelPicker: ModelSelectPicker | null = null
  function ensureModelPicker(): ModelSelectPicker {
    modelPicker ??= mountModelSelectPicker(modelSelect, {
      loadOptions: async (current) => [
        { value: '', label: KEEP_MODEL_LABEL },
        ...(await fetchModelOptions(api, current)),
      ],
      ariaLabel: 'Profile model',
      loadOnMount: false,
    })
    return modelPicker
  }

  function setStatus(text: string): void {
    status.textContent = text
    status.hidden = text === ''
  }

  function summary(profile: AgentProfile): string {
    const parts = [
      profile.model ? modelDisplayLabel(profile.model) : KEEP_MODEL_LABEL,
      ...(profile.reasoning ? [`${EFFORT_LABELS[profile.reasoning]} effort`] : []),
      profile.instructions?.trim() ? 'with instructions' : 'no instructions',
    ]
    return parts.join(' · ')
  }

  function renderList(): void {
    clear(list)
    if (profiles.length === 0) {
      list.append(el('p', { class: 'field-hint' }, 'No profiles yet.'))
    }
    for (const profile of profiles) {
      const edit = el('button', { type: 'button', class: 'agent-profile-edit' }, 'Edit')
      const remove = el('button', { type: 'button', class: 'agent-profile-delete' }, 'Remove')
      edit.addEventListener('click', () => {
        openForm(profile)
      })
      remove.addEventListener('click', () => {
        void persist(profiles.filter((candidate) => candidate.id !== profile.id))
      })
      list.append(
        el(
          'div',
          { class: 'agent-profile-row', 'data-profile-id': profile.id },
          el(
            'div',
            { class: 'agent-profile-summary' },
            el('strong', {}, profile.name),
            el('div', { class: 'field-hint' }, summary(profile)),
          ),
          el('div', { class: 'agent-profile-row-actions' }, edit, remove),
        ),
      )
    }
    addButton.disabled = profiles.length >= AGENT_PROFILES_MAX
  }

  function openForm(profile: AgentProfile | null): void {
    editingId = profile?.id ?? null
    formTitle.textContent = profile ? `Edit ${profile.name}` : 'New profile'
    nameInput.value = profile?.name ?? ''
    modelSelect.value = profile?.model ?? ''
    effortSelect.value = profile?.reasoning ?? ''
    instructionsInput.value = profile?.instructions ?? ''
    form.hidden = false
    addButton.hidden = true
    setStatus('')
    void ensureModelPicker().refresh(modelSelect.value)
    nameInput.focus()
  }

  function closeForm(): void {
    editingId = null
    form.hidden = true
    addButton.hidden = false
  }

  async function persist(next: AgentProfile[]): Promise<boolean> {
    const parsed = agentProfilesSchema.safeParse(next)
    if (!parsed.success) {
      setStatus('That profile could not be saved. Check its name and instructions.')
      return false
    }
    try {
      await api.settings.set(AGENT_PROFILES_SETTING, parsed.data)
    } catch {
      setStatus('Could not save profiles. Please try again.')
      return false
    }
    profiles = parsed.data
    renderList()
    opts.onChanged?.()
    return true
  }

  addButton.addEventListener('click', () => {
    openForm(null)
  })
  // The fields sit inside the Settings form: Enter saves the profile, not Settings.
  nameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    saveButton.click()
  })
  cancelButton.addEventListener('click', closeForm)
  saveButton.addEventListener('click', () => {
    const name = nameInput.value.trim()
    if (!name) {
      setStatus('Give the profile a name.')
      nameInput.focus()
      return
    }
    const instructions = instructionsInput.value.trim()
    const model = modelSelect.value
    const effort = effortSelect.value
    const id = editingId ?? newAgentProfileId(name, profiles)
    const profile: AgentProfile = {
      id,
      name,
      ...(model ? { model } : {}),
      ...(isReasoningLevel(effort) ? { reasoning: effort } : {}),
      ...(instructions ? { instructions } : {}),
    }
    const next = editingId
      ? profiles.map((candidate) => (candidate.id === editingId ? profile : candidate))
      : [...profiles, profile]
    void persist(next).then((saved) => {
      if (saved) closeForm()
    })
  })

  return {
    root,
    refresh: async (signal?: AbortSignal): Promise<void> => {
      const raw = await api.settings.get(AGENT_PROFILES_SETTING).catch(() => undefined)
      if (signal?.aborted) return
      const parsed = agentProfilesSchema.safeParse(raw ?? [])
      profiles = parsed.success ? parsed.data : []
      closeForm()
      setStatus('')
      renderList()
    },
  }
}
